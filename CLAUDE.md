# CLAUDE.md

## Project Overview
MCP server for managing Cloudflare DNS across multiple zones (domains) from one API token. Supports listing zones and records, creating A and CNAME records, toggling the Cloudflare proxy (orange/grey cloud), and general record update/delete. Human-facing install and usage docs live in `README.md`.

New A/CNAME records are created with `proxied: false` (DNS-only) by default — callers must opt in to proxying.

## Commands
- `bun run start` — Run the server (stdio transport)
- `bun run dev` — Run with hot reload
- `bun run typecheck` — `tsc --noEmit`
- `bun run build` — Compile to `dist/` (also chmods `dist/index.js` as the `bin` entry)

## Package Layout
- Source: `src/index.ts` (single file, starts with `#!/usr/bin/env node` so the compiled `dist/index.js` is directly executable as the `bin` entry).
- Published artifacts: `dist/` and `README.md` only (see `files` in `package.json`).
- Runtime: published JS targets Node ≥18; `bun` is supported for local dev and at runtime (bunx / bun install -g) because the code uses only stdlib APIs (`fetch`, `process.env`, stdio).

## Architecture
Single-file MCP server at `src/index.ts`:
- Env validation at startup (`CLOUDFLARE_API_TOKEN`)
- `cfFetch()` helper wraps `fetch` against `https://api.cloudflare.com/client/v4` with bearer auth and Cloudflare response envelope unwrapping (throws on `success: false`)
- `resolveZoneId()` accepts either a 32-char zone ID or a domain name (looks it up by `?name=`), so tool callers can pass `"example.com"` without first fetching zone IDs. Takes an optional `Map<string, Promise<ZoneRef>>` cache used by bulk tools to dedupe lookups.
- Tools registered via `server.registerTool()` with appropriate annotations
- Stdio transport for MCP client communication

## Tools
| Tool | Purpose |
|---|---|
| `list_zones` | Discover which domains the token can manage |
| `list_dns_records` | List records in a zone (optional type/name filter). Auto-paginates unless `page` is set. |
| `bulk_list_dns_records` | List records across many zones in one call; concurrent per-zone auto-pagination |
| `create_a_record` | Create A record; `proxied` defaults to `false` |
| `create_cname_record` | Create CNAME record; `proxied` defaults to `false` |
| `toggle_proxy` | Flip proxy on/off by record ID or by name (+ optional type) |
| `bulk_toggle_proxy` | Flip many records' proxy in one call (shared `proxied` value, concurrent) |
| `update_dns_record` | Patch `content`, `ttl`, `proxied`, or `comment` on a record |
| `bulk_update_dns_record` | PATCH many records in one call with per-item fields, concurrent |
| `delete_dns_record` | Delete a record by ID (destructive) |

Bulk tools share a per-invocation zone-ID cache, so multiple targets in the same zone only resolve that zone once.

Bulk-tool result shape: `{results: Array<{ok: true, record} | {ok: false, error}>, succeeded, failed}`, with `isError: true` when any item fails (all results still returned).

## Environment Variables
- `CLOUDFLARE_API_TOKEN` — Cloudflare API token with `Zone:Read` and `Zone:DNS:Edit` permissions (scope to the zones you want to manage, or "All zones"). Create one at https://dash.cloudflare.com/profile/api-tokens.

`.mcp.json` is gitignored and holds the live token used by the local MCP client — never stage, print, or share its contents. `CLAUDE.local.md` (also gitignored) holds developer-machine specifics like absolute paths.
