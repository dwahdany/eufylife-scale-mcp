# EufyLife scale MCP server on Cloudflare Workers

A remote version of this repository's MCP server, for use as a **custom connector** in Claude
(web, desktop, mobile, Claude Code) or any other MCP client that speaks Streamable HTTP with
OAuth. Same three read-only tools as the Python server: `list_members`,
`get_latest_measurement`, `get_measurement_history`.

EufyLife has no OAuth of its own, so this Worker is the OAuth 2.1 authorization server. When a
client connects, the user sees a sign-in page, enters their EufyLife email and password once,
and is sent back to the client. The Worker logs in to EufyLife with those credentials, discards
the password, and stores only the EufyLife **session token** (plus user id and member list) as
the grant. The library encrypts the grant with a key only the holder of the matching OAuth
token can unwrap, so the KV namespace never holds a usable credential on its own.

EufyLife session tokens last 30 days and cannot be refreshed, so OAuth tokens are capped to the
session's remaining lifetime. After 30 days the client asks the user to sign in again.

## Deploy your own

Requirements: Node 22+, a Cloudflare account (the free Workers plan is enough: one KV namespace,
no Durable Objects).

```bash
cd worker
npm install
npx wrangler login
npx wrangler kv namespace create OAUTH_KV      # paste the id into wrangler.jsonc
npx wrangler deploy
```

The deploy prints your URL, for example `https://eufylife-scale-mcp.<subdomain>.workers.dev`.
The MCP endpoint is that URL plus `/mcp`. Open the URL itself for a page with connection
instructions.

To serve on a custom domain, add a route in `wrangler.jsonc` and set `MCP_RESOURCE` to the
exact `https://your-domain/mcp` URL (tokens are bound to it).

### Deploy on every push (Workers Builds)

Connect the repository under Workers → your worker → Settings → Build and set:

| Setting | Value |
| --- | --- |
| Production branch | `master` |
| Root directory | `worker/` |
| Build command | *(none; the lockfile is installed automatically)* |
| Deploy command | `npx wrangler deploy` |
| Include paths | `worker/**` (skip builds for Python-only commits) |

The build uses a scoped API token that Cloudflare creates for you, so no secret lives in GitHub.

## Connect

- **Claude (claude.ai / Desktop / mobile):** Customize → Connectors → Add custom connector →
  paste the `/mcp` URL. Keep the default OAuth settings ("Use Claude's published identity" or
  "Register automatically" both work). Click Connect and sign in with your EufyLife account.
- **Claude Code:** `claude mcp add --transport http eufylife https://<your-worker>/mcp`, then
  `/mcp` in a session to sign in.

## Endpoints

| Path | Purpose |
|---|---|
| `/mcp` | MCP (Streamable HTTP, stateless). Needs `Authorization: Bearer <token>`; otherwise answers a 401 that points at the OAuth metadata |
| `/authorize` | Sign-in page (GET) and sign-in submit (POST) |
| `/token`, `/register` | OAuth token and dynamic client registration endpoints |
| `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource/mcp` | OAuth discovery |
| `/health` | `{"status":"ok"}` |

## Privacy

- The password is used for one request to EufyLife and never stored or logged.
- Stored per connection, encrypted: EufyLife session token, user id, country, member names and ids.
- Stored in the clear with the grant: the country code and the OAuth client id. No email, no names.
- Measurements are fetched on demand and never stored. Logs hold no tool inputs or outputs.
- Revoke access by removing the connector in Claude, or by changing your EufyLife password
  (which invalidates the session token).

## Development

```bash
npm run type-check
npm test                 # unit tests (member resolution, formatting, OAuth helpers)
npm run dev              # local server on http://localhost:8787
```
