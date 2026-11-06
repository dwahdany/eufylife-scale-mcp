/**
 * Pure logic shared by the tools: member lookup and conversion of measurements into the
 * JSON shape the tools return. Mirrors eufylife_mcp.service.resolve_member and
 * eufylife_mcp.formatting in the Python package, so both servers answer alike.
 */
import type { Measurement, Member, ScaleData } from "./eufy";

/** A problem with the tool call itself (bad member, nothing recorded). Message is user-facing. */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

/** No member profile matches the requested identifier. Callers may refresh the list and retry. */
export class UnknownMemberError extends ToolInputError {
  constructor(message: string) {
    super(message);
    this.name = "UnknownMemberError";
  }
}

function describe(members: Member[]): string {
  if (members.length === 0) return "none";
  return members.map((m) => `${m.name} (${m.id})`).join(", ");
}

function squash(text: string): string {
  return text.split(/\s+/).filter(Boolean).join(" ");
}

/**
 * Pick the member named by `identifier` (id or name, case-insensitive).
 * Empty means the only member, or else the account's default (owner) member.
 */
export function resolveMember(members: Member[], identifier: string | null | undefined): Member {
  const text = squash(identifier ?? "");
  if (!text) {
    if (members.length === 1) return members[0];
    if (members.length === 0) throw new ToolInputError("This EufyLife account has no member profiles.");
    const defaults = members.filter((m) => m.isDefault);
    if (defaults.length === 1) return defaults[0];
    throw new ToolInputError(
      "This account has several members; pass `member` as one of: " + describe(members),
    );
  }
  const key = text.toLocaleLowerCase();
  let matches = members.filter((m) => m.id.toLocaleLowerCase() === key);
  if (matches.length === 0) matches = members.filter((m) => squash(m.name).toLocaleLowerCase() === key);
  if (matches.length === 0) {
    matches = members.filter((m) => (squash(m.name).split(" ")[0] ?? "").toLocaleLowerCase() === key);
  }
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new ToolInputError(
      `Member '${text}' is ambiguous; pass the member_id of one of: ${describe(matches)}`,
    );
  }
  throw new UnknownMemberError(
    `No member matches '${text}'. Members on this account: ${describe(members)}`,
  );
}

const LB_PER_KG = 2.2046226218;

/** (output key, scale_data field). Weight is handled separately: the API reports tenths of a kg. */
const METRICS: readonly [string, keyof ScaleData][] = [
  ["bmi", "bmi"],
  ["body_fat_pct", "body_fat"],
  ["body_fat_mass_kg", "body_fat_mass"],
  ["subcutaneous_fat_pct", "subcutaneous_fat_rate"],
  ["visceral_fat_level", "visceral_fat"],
  ["muscle_pct", "muscle"],
  ["muscle_mass_kg", "muscle_mass"],
  ["skeletal_muscle_mass_kg", "skeletal_muscle_mass"],
  ["fat_free_mass_kg", "fat_free_weight"],
  ["bone_mass_kg", "bone_mass"],
  ["water_pct", "water"],
  ["protein_pct", "protein_ratio"],
  ["bmr_kcal", "bmr"],
  ["body_age_years", "body_age"],
  ["heart_rate_bpm", "heart_rate"],
];

export type MemberDict = { member_id: string; name: string; is_default: boolean };
export type MeasurementDict = Record<string, string | number>;

export function memberToDict(member: Member): MemberDict {
  return { member_id: member.id, name: member.name, is_default: member.isDefault };
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/** Python's datetime.isoformat() for a UTC instant: `2026-11-06T09:02:06+00:00`. */
export function isoUtc(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

/** Only metrics the scale measured are included; it reports 0 for the rest. */
export function measurementToDict(measurement: Measurement): MeasurementDict {
  const data = measurement.scaleData;
  const result: MeasurementDict = {
    measurement_id: measurement.id,
    timestamp_utc: isoUtc(measurement.time),
  };
  if (data.weight) {
    const kg = data.weight / 10;
    result.weight_kg = round(kg, 2);
    result.weight_lb = round(kg * LB_PER_KG, 1);
  }
  for (const [key, field] of METRICS) {
    const value = data[field];
    if (value) result[key] = round(value, 2);
  }
  return result;
}

export function latestResponse(member: Member, measurement: Measurement, nowMs = Date.now()) {
  const reading = measurementToDict(measurement);
  const elapsedSeconds = Math.floor(nowMs / 1000) - measurement.time;
  reading.age_hours = Math.floor(elapsedSeconds / 3600);
  return { member: memberToDict(member), measurement: reading };
}

export function historyResponse(member: Member, measurements: Measurement[], days: number) {
  const ordered = [...measurements].sort((a, b) => a.time - b.time);
  return {
    member: memberToDict(member),
    days,
    count: ordered.length,
    measurements: ordered.map(measurementToDict),
  };
}

/** Newest measurement that belongs to `member`, or null. */
export function latestFor(member: Member, measurements: Measurement[]): Measurement | null {
  let best: Measurement | null = null;
  for (const m of measurements) {
    if (m.customerId !== member.id) continue;
    if (best === null || m.time > best.time) best = m;
  }
  return best;
}

export function historyFor(member: Member, measurements: Measurement[], afterSeconds: number): Measurement[] {
  return measurements.filter((m) => m.customerId === member.id && m.time > afterSeconds);
}
