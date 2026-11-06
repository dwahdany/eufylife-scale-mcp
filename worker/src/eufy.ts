/**
 * Minimal client for the EufyLife cloud API: login, member profiles, scale measurements.
 *
 * EufyLife has no public API. These are the calls the mobile app makes, following
 * m4ary/eufylife-api-hacs and the Python package in this repository. The API answers
 * most failures with HTTP 200 and a non-1 `res_code`; 401 in `res_code` means the
 * session token is no longer valid.
 */

export const LOGIN_URL = "https://home-api.eufylife.com/v1/user/v2/email/login/";
export const API_BASE = "https://api.eufylife.com/v1";
/** Bump when EufyLife starts rejecting the current app version. */
export const APP_VERSION = "3.3.12";
const CLIENT_ID = "eufy-app";
const CLIENT_SECRET = "8FHf22gaTKu7MZXqz5zytw";

const OK = 1;
const DEFAULT_EXPIRES_IN_S = 30 * 24 * 3600;
const REQUEST_TIMEOUT_MS = 20_000;

export type EufyErrorKind =
  | "login_rejected" // bad email/password or another non-1 res_code from the login call
  | "auth" // session token expired or rejected
  | "rate_limited"
  | "api" // unexpected HTTP status or non-1 res_code
  | "network"
  | "shape"; // response did not look like what we expect

export class EufyError extends Error {
  readonly kind: EufyErrorKind;
  /** `res_code` or HTTP status that caused the error, when there is one. */
  readonly code?: number;
  readonly retryAfter?: number;

  constructor(kind: EufyErrorKind, message: string, extra: { code?: number; retryAfter?: number } = {}) {
    super(message);
    this.name = "EufyError";
    this.kind = kind;
    this.code = extra.code;
    this.retryAfter = extra.retryAfter;
  }
}

export interface Member {
  id: string;
  name: string;
  isDefault: boolean;
}

/** Raw `scale_data` of one weigh-in. The scale reports 0 for metrics it did not measure. */
export interface ScaleData {
  weight: number; // tenths of a kilogram
  bmi: number;
  body_fat: number; // %
  body_fat_mass: number; // kg
  subcutaneous_fat_rate: number; // %
  visceral_fat: number; // level
  muscle: number; // %
  muscle_mass: number; // kg
  skeletal_muscle_mass: number; // kg
  fat_free_weight: number; // kg
  bone_mass: number; // kg
  water: number; // %
  protein_ratio: number; // %
  bmr: number; // kcal/day
  body_age: number; // years
  heart_rate: number; // bpm
}

export const SCALE_DATA_FIELDS: readonly (keyof ScaleData)[] = [
  "weight",
  "bmi",
  "body_fat",
  "body_fat_mass",
  "subcutaneous_fat_rate",
  "visceral_fat",
  "muscle",
  "muscle_mass",
  "skeletal_muscle_mass",
  "fat_free_weight",
  "bone_mass",
  "water",
  "protein_ratio",
  "bmr",
  "body_age",
  "heart_rate",
];

export interface Measurement {
  id: string;
  customerId: string;
  /** Unix seconds, UTC. */
  time: number;
  scaleData: ScaleData;
}

/** What a successful login gives us. This is what the OAuth grant stores (never the password). */
export interface EufySession {
  accessToken: string;
  userId: string;
  /** Two-letter country code the account was created in. */
  country: string;
  /** Unix seconds when EufyLife says the token stops working. */
  expiresAt: number;
  members: Member[];
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function asNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return 0;
}

export function parseMembers(raw: unknown): Member[] {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) throw new EufyError("shape", "customers is not a list");
  const members: Member[] = [];
  for (const item of raw) {
    if (!isObject(item)) throw new EufyError("shape", "customer is not an object");
    const id = asString(item.id);
    if (!id) throw new EufyError("shape", "customer without id");
    const name = typeof item.name === "string" ? item.name.trim() : "";
    members.push({ id, name, isDefault: item.default === true });
  }
  return members;
}

/** Parses one `data` record. Returns null for records that lack the fields we need. */
export function parseMeasurement(raw: unknown): Measurement | null {
  if (!isObject(raw)) return null;
  const id = asString(raw.id);
  const customerId = asString(raw.customer_id);
  const time = raw.create_time;
  if (!id || !customerId || typeof time !== "number" || !Number.isFinite(time)) return null;
  if (!isObject(raw.scale_data)) return null;
  const scaleData = {} as ScaleData;
  for (const field of SCALE_DATA_FIELDS) scaleData[field] = asNumber(raw.scale_data[field]);
  return { id, customerId, time: Math.floor(time), scaleData };
}

export function parseMeasurements(raw: unknown): Measurement[] {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) throw new EufyError("shape", "data is not a list");
  const out: Measurement[] = [];
  for (const item of raw) {
    const parsed = parseMeasurement(item);
    if (parsed) out.push(parsed);
  }
  return out;
}

function normaliseCountry(country: string): string {
  const code = country.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : "US";
}

async function send(request: Request): Promise<Json> {
  let response: Response;
  try {
    response = await fetch(request, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    const kind = error instanceof Error ? error.name : "Error";
    throw new EufyError("network", `Could not reach EufyLife (${kind})`);
  }
  if (response.status === 429) {
    const header = response.headers.get("Retry-After") ?? "";
    throw new EufyError("rate_limited", "Rate limited by EufyLife", {
      retryAfter: /^\d+$/.test(header) ? Number(header) : undefined,
    });
  }
  if (response.status === 401) throw new EufyError("auth", "EufyLife returned HTTP 401", { code: 401 });
  if (!response.ok) throw new EufyError("api", `EufyLife returned HTTP ${response.status}`, { code: response.status });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new EufyError("shape", "EufyLife returned a non-JSON body");
  }
  if (!isObject(body)) throw new EufyError("shape", "EufyLife returned a non-object body");
  return body;
}

/**
 * Logs in with email and password. The password is used for this one request only.
 * Members ("customers") come with the login response, so they are returned here too.
 */
export async function login(email: string, password: string, country: string): Promise<EufySession> {
  const cc = normaliseCountry(country);
  const request = new Request(LOGIN_URL, {
    method: "POST",
    headers: {
      accept: "*/*",
      "user-agent": `EufyLife-Android-${APP_VERSION}`,
      category: "Health",
      language: "en",
      timezone: "UTC",
      country: cc,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      client_Secret: CLIENT_SECRET, // the app really capitalises this key on this host
      email,
      password,
      ab: cc.toLowerCase(),
      un_subscribe_flag: true,
    }),
  });
  const data = await send(request);
  const code = data.res_code;
  if (code !== OK) {
    const message = typeof data.message === "string" ? data.message : "";
    throw new EufyError("login_rejected", message || "EufyLife rejected the login", {
      code: typeof code === "number" ? code : 0,
    });
  }
  const accessToken = asString(data.access_token);
  const userId = asString(data.user_id);
  if (!accessToken || !userId) throw new EufyError("shape", "login response without token or user id");
  const rawExpiresIn = data.expires_in;
  const expiresIn =
    typeof rawExpiresIn === "number" && Number.isFinite(rawExpiresIn) && rawExpiresIn > 0
      ? rawExpiresIn
      : DEFAULT_EXPIRES_IN_S;
  return {
    accessToken,
    userId,
    country: cc,
    expiresAt: Math.floor(Date.now() / 1000) + Math.floor(expiresIn),
    members: parseMembers(data.customers),
  };
}

async function authedGet(session: Pick<EufySession, "accessToken" | "userId">, path: string, params?: Record<string, string>): Promise<Json> {
  const url = new URL(`${API_BASE}${path}`);
  for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, value);
  const request = new Request(url, {
    method: "GET",
    headers: {
      accept: "*/*",
      uid: session.userId,
      token: session.accessToken,
      "user-agent": `Eufylife-iOS-${APP_VERSION}-281`,
      "accept-language": "en-US,en;q=0.9",
    },
  });
  const body = await send(request);
  const code = body.res_code;
  if (code === OK) return body;
  if (code === 401) throw new EufyError("auth", "EufyLife session token is no longer valid", { code: 401 });
  throw new EufyError("api", `EufyLife API error ${String(code)}`, { code: typeof code === "number" ? code : 0 });
}

/** Current member profiles. Works with just the session token, no re-login needed. */
export async function fetchMembers(session: Pick<EufySession, "accessToken" | "userId">): Promise<Member[]> {
  const body = await authedGet(session, "/user/customers");
  return parseMembers(body.customers);
}

/** Every weigh-in on the account, or only those strictly after `after` (Unix seconds). */
export async function fetchMeasurements(
  session: Pick<EufySession, "accessToken" | "userId">,
  after?: number,
): Promise<Measurement[]> {
  const body = await authedGet(session, "/device/data", after === undefined ? undefined : { after: String(Math.floor(after)) });
  return parseMeasurements(body.data);
}
