# eufylife-scale-mcp

<!-- mcp-name: io.github.osjayaprakash/eufylife-scale-mcp -->

[![CI](https://github.com/osjayaprakash/eufylife-scale-mcp/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/osjayaprakash/eufylife-scale-mcp/actions/workflows/ci.yml)
[![PyPI](https://img.shields.io/pypi/v/eufylife-scale-mcp)](https://pypi.org/project/eufylife-scale-mcp/)
[![Python](https://img.shields.io/pypi/pyversions/eufylife-scale-mcp)](https://pypi.org/project/eufylife-scale-mcp/)
[![Docker](https://img.shields.io/badge/docker-ghcr.io-2496ED?logo=docker&logoColor=white)](https://github.com/osjayaprakash/eufylife-scale-mcp/pkgs/container/eufylife-scale-mcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](https://github.com/osjayaprakash/eufylife-scale-mcp/blob/master/LICENSE)

An MCP server that gives Claude (or any MCP client) read-only access to the weight and
body composition measured by Eufy smart scales and synced to the EufyLife app. It talks to
the EufyLife cloud API with its own small async client (`eufylife_mcp.core`); the API
behaviour it relies on follows [eufylife-api-hacs](https://github.com/m4ary/eufylife-api-hacs)
and [eufylife-mcp](https://github.com/MatthewHallCom/eufylife-mcp).

EufyLife has no public API. This server logs in the way the app does, so it can break
when Eufy changes the app's API.

## Tools

| Tool | Returns |
|---|---|
| `list_members` | Member profiles (people) on the EufyLife account |
| `get_latest_measurement` | Most recent weigh-in with body composition |
| `get_measurement_history` | Weigh-ins from the last `days` days (default 30), oldest first |

The measurement tools take an optional `member`: a name (`"Ann"`) or a `member_id` from
`list_members`. When omitted, the account owner (the default member) is used.
Profiles added, renamed or removed in the EufyLife app show up in `list_members` within
five minutes; asking for a new member by name finds them right away.

Measurements include `timestamp_utc`, `weight_kg`, `weight_lb`, and whatever body
composition the scale measured: `bmi`, `body_fat_pct`, `body_fat_mass_kg`,
`subcutaneous_fat_pct`, `visceral_fat_level`, `muscle_pct`, `muscle_mass_kg`,
`skeletal_muscle_mass_kg`, `fat_free_mass_kg`, `bone_mass_kg`, `water_pct`,
`protein_pct`, `bmr_kcal`, `body_age_years` and `heart_rate_bpm`. Metrics the scale did not
measure (for example when weighing in with socks on) are left out. The latest measurement
also has `age_hours`.

## Setup

For a step-by-step guide, including troubleshooting, see the
[installation guide](https://eufylife-scale-mcp.readthedocs.io/en/latest/install/).
Full documentation is at <https://eufylife-scale-mcp.readthedocs.io>.

You need the EufyLife account (email and password) that your scale syncs to. Accounts that
sign in with Google or Apple have no password; set one in the EufyLife app first.

```bash
git clone https://github.com/osjayaprakash/eufylife-scale-mcp.git && cd eufylife-scale-mcp
uv sync
```

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `EUFYLIFE_EMAIL` | yes | | EufyLife account email |
| `EUFYLIFE_PASSWORD` | yes | | EufyLife account password |
| `EUFYLIFE_COUNTRY` | no | `US` | Two-letter country code of the account, e.g. `GB`, `DE` |

### Run from PyPI

No clone needed; [uv](https://docs.astral.sh/uv/) fetches and runs the published package:

```bash
uvx eufylife-scale-mcp
```

In a client config, use `"command": "uvx", "args": ["eufylife-scale-mcp"]`.

### Run with Docker

The server speaks MCP over stdio, so keep `-i`:

```bash
docker run -i --rm \
  -e EUFYLIFE_EMAIL -e EUFYLIFE_PASSWORD -e EUFYLIFE_COUNTRY \
  ghcr.io/osjayaprakash/eufylife-scale-mcp:latest
```

In a client config, use `"command": "docker"` with those arguments, and pass the
variables through the client's `env` block.

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "eufylife": {
      "command": "uv",
      "args": ["--directory", "/absolute/path/to/eufylife-scale-mcp", "run", "eufylife-scale-mcp"],
      "env": {
        "EUFYLIFE_EMAIL": "you@example.com",
        "EUFYLIFE_PASSWORD": "your-password",
        "EUFYLIFE_COUNTRY": "US"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add eufylife \
  -e EUFYLIFE_EMAIL=you@example.com \
  -e EUFYLIFE_PASSWORD=your-password \
  -e EUFYLIFE_COUNTRY=US \
  -- uv --directory /absolute/path/to/eufylife-scale-mcp run eufylife-scale-mcp
```

## Langfuse tracing (optional)

Each tool call becomes a Langfuse trace, with a child span for the EufyLife API call.
Install the extra and set the keys:

```bash
uv sync --extra langfuse
```

In the server command, use `run --extra langfuse eufylife-scale-mcp` instead of
`run eufylife-scale-mcp`.

| Variable | Meaning |
|---|---|
| `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` | Tracing is on only when both are set |
| `LANGFUSE_BASE_URL` | Langfuse URL for self-hosted or regional instances (default: Langfuse Cloud) |
| `LANGFUSE_CAPTURE_DATA` | `true` to include tool inputs, outputs and error messages. Default `false` |

**Privacy:** weight and body composition are health data. By default, traces hold only
tool names, timings, member IDs, and error class names. Setting `LANGFUSE_CAPTURE_DATA=true`
sends measurements and names to your Langfuse instance; only do that with an instance you
trust, such as a self-hosted one.

## Development

```bash
uv sync
uv run pytest            # offline suite
uv run pytest -m live    # hits the real API; needs EUFYLIFE_EMAIL/PASSWORD
uv run ruff check src tests && uv run ruff format --check src tests
```

## Releasing

Bump `version` in `pyproject.toml` and `server.json` (both places in each package entry),
then push a matching tag:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

That tag publishes to PyPI (`pypi.yml`, needs the `PYPI_API_TOKEN` secret), to
`ghcr.io/osjayaprakash/eufylife-scale-mcp` (`docker.yml`), and then to the MCP Registry
(`mcp-registry.yml`). Read the Docs builds the documentation from `master`.

## License

[MIT](https://github.com/osjayaprakash/eufylife-scale-mcp/blob/master/LICENSE)
