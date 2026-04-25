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
- Source: `src/` (entry `src/index.ts` starts with `#!/usr/bin/env node` so the compiled `dist/index.js` is directly executable as the `bin` entry).
- Published artifacts: `dist/` and `README.md` only (see `files` in `package.json`).
- Runtime: published JS targets Node ≥18; `bun` is supported for local dev and at runtime (bunx / bun install -g) because the code uses only stdlib APIs (`fetch`, `process.env`, stdio).

## Architecture
Modular MCP server. `src/index.ts` is a ~20-line entry: env check, `McpServer`, `register<Group>Tools(server)` calls, stdio transport.

- `src/cf/client.ts` — `cfFetch()` wraps `https://api.cloudflare.com/client/v4` with bearer auth and envelope unwrapping (throws on `success: false`).
- `src/cf/zone.ts` — `resolveZoneId()` accepts a zone ID or domain; takes an optional `ZoneCache` (`Map<string, Promise<ZoneRef>>`) for per-invocation dedupe across bulk tools.
- `src/format.ts` — response formatters (see "Tool responses" below).
- `src/tools/<group>.ts` — each exports `register<Group>Tools(server)`. Currently only `dns.ts`; add a new file per CF API surface (workers, tunnels, …) and wire one `register…(server)` line into `src/index.ts`.

Relative imports use `.js` extensions — required by Node ESM at runtime; `moduleResolution: bundler` makes the typechecker accept it without complaint.

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

Bulk tools return a text summary via `bulkListResult` / `bulkMutationResult`: header line with `succeeded`/`failed` counts, per-failure `FAIL: <ref> - <error>` lines, and (for lists) a flat TSV of all records. `isError: true` whenever any item fails.

## Tool responses
Prefer `src/format.ts` helpers over JSON dumps (10–50× fewer tokens):

- `listResult(items, cols, total?)` — TSV; define `<ENTITY>_COLUMNS` per group (dns uses `id,type,name,content,proxied,ttl`). Supports dot-notation (`account.name`).
- `mutationResult(action, entity, item)` — one-liner `OK: <entity> <id> <action> (<name>)` for create/update/delete/toggle.
- `bulkListResult` / `bulkMutationResult` — flat TSV / per-line `OK:`/`FAIL:` with summary header; sets `isError: true` when any item fails.
- `errorResult(e)` — uniform `Failed: <message>` with `isError: true`; use in every `catch`.

## Environment Variables
- `CLOUDFLARE_API_TOKEN` — Cloudflare API token with `Zone:Read` and `Zone:DNS:Edit` permissions (scope to the zones you want to manage, or "All zones"). Create one at https://dash.cloudflare.com/profile/api-tokens.

`.mcp.json` is gitignored and holds the live token used by the local MCP client — never stage, print, or share its contents. `CLAUDE.local.md` (also gitignored) holds developer-machine specifics like absolute paths.
