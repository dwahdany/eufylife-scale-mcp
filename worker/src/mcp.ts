/**
 * The MCP server: three read-only tools over one EufyLife session. The session comes from the
 * OAuth grant props (see oauth.ts); a fresh McpServer is built for every request.
 */
import { McpServer } from "@modelcontextprotocol/server";
import { getMcpAuthContext } from "agents/mcp/server";
import { z } from "zod";

import { EufyError, fetchMeasurements, fetchMembers, type EufySession, type Member } from "./eufy";
import {
  ToolInputError,
  UnknownMemberError,
  historyFor,
  historyResponse,
  latestFor,
  latestResponse,
  memberToDict,
  resolveMember,
} from "./scale";

export const SERVER_NAME = "eufylife";
export const SERVER_VERSION = "0.1.0";

export const INSTRUCTIONS =
  "Read-only access to weight and body composition measured by EufyLife smart scales. " +
  "Weight is given in kg and lb; other metrics use the unit in their key " +
  "(e.g. `body_fat_pct`, `muscle_mass_kg`). Metrics the scale did not measure are " +
  "omitted. Timestamps are UTC.";

/** What the OAuth grant carries, encrypted, for one connected EufyLife account. */
export type GrantProps = EufySession;

export const RECONNECT_HINT = "Reconnect the EufyLife connector to sign in again.";

const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

const MemberArg = z
  .string()
  .nullable()
  .optional()
  .describe("Name (e.g. 'Ann') or member_id from list_members. Omit for the account owner, or when the account has one member.");

const DaysArg = z
  .number()
  .int()
  .min(1)
  .max(3650)
  .default(30)
  .describe("How many days back to include, counting from now.");

type ToolResult = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

function ok(payload: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
}

function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Turn a client error into the text the model sees. Never includes tokens or measurements. */
export function describeError(error: unknown): string {
  if (error instanceof ToolInputError) return error.message;
  if (error instanceof EufyError) {
    switch (error.kind) {
      case "auth":
        return `EufyLife session expired. ${RECONNECT_HINT}`;
      case "login_rejected":
        return `EufyLife rejected the login. ${RECONNECT_HINT}`;
      case "rate_limited":
        return `Rate limited by EufyLife. Try again ${error.retryAfter ? `in ${error.retryAfter} seconds` : "later"}.`;
      case "api":
        return `EufyLife API error ${error.code ?? ""}`.trim() + ".";
      case "network":
        return error.message + ".";
      case "shape":
        return "EufyLife returned unexpected data.";
    }
  }
  return "Unexpected error while talking to EufyLife.";
}

function isGrantProps(value: unknown): value is GrantProps {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.accessToken === "string" &&
    typeof v.userId === "string" &&
    typeof v.expiresAt === "number" &&
    Array.isArray(v.members)
  );
}

export function currentSession(): GrantProps | undefined {
  const props = getMcpAuthContext()?.props;
  return isGrantProps(props) ? props : undefined;
}

/**
 * Resolve `identifier` against the members stored in the grant; if nobody matches, fetch the
 * current list from EufyLife (a member may have been added or renamed in the app) and retry.
 */
async function resolveWithRefresh(session: EufySession, identifier: string | null | undefined): Promise<Member> {
  try {
    return resolveMember(session.members, identifier);
  } catch (error) {
    if (!(error instanceof UnknownMemberError)) throw error;
    return resolveMember(await fetchMembers(session), identifier);
  }
}

async function run(fn: () => Promise<Record<string, unknown>>): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (error) {
    return fail(describeError(error));
  }
}

export function createServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
  const session = currentSession();

  server.registerTool(
    "list_members",
    {
      title: "List members",
      description: "List the member profiles (people) on this EufyLife account.",
      annotations: READ_ONLY,
    },
    async () =>
      run(async () => {
        if (!session) throw new EufyError("auth", "no session");
        const members = await fetchMembers(session);
        return { members: members.map(memberToDict) };
      }),
  );

  server.registerTool(
    "get_latest_measurement",
    {
      title: "Latest measurement",
      description:
        "Most recent weigh-in with its body composition.\n\n" +
        "Check `age_hours`: this is the last time the person stepped on the scale.",
      inputSchema: z.object({ member: MemberArg }),
      annotations: READ_ONLY,
    },
    async ({ member }) =>
      run(async () => {
        if (!session) throw new EufyError("auth", "no session");
        const resolved = await resolveWithRefresh(session, member);
        const latest = latestFor(resolved, await fetchMeasurements(session));
        if (!latest) throw new ToolInputError(`No scale measurements recorded for ${resolved.name}.`);
        return latestResponse(resolved, latest);
      }),
  );

  server.registerTool(
    "get_measurement_history",
    {
      title: "Measurement history",
      description: "Weigh-ins from the last `days` days (default 30), oldest first.",
      inputSchema: z.object({ member: MemberArg, days: DaysArg }),
      annotations: READ_ONLY,
    },
    async ({ member, days }) =>
      run(async () => {
        if (!session) throw new EufyError("auth", "no session");
        const resolved = await resolveWithRefresh(session, member);
        const after = Math.floor(Date.now() / 1000) - days * 86400;
        const records = await fetchMeasurements(session, after);
        return historyResponse(resolved, historyFor(resolved, records, after), days);
      }),
  );

  return server;
}
