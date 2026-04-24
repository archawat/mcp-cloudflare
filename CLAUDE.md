# CLAUDE.md

## Project Overview
MCP server for managing Cloudflare DNS across multiple zones (domains) from one API token. Supports listing zones and records, creating A and CNAME records, toggling the Cloudflare proxy (orange/grey cloud), and general record update/delete.

New A/CNAME records are created with `proxied: false` (DNS-only) by default — callers must opt in to proxying.

## Commands
- `bun run start` — Run the server (stdio transport)
- `bun run dev` — Run with hot reload
- `bunx tsc --noEmit` — Type check

## Architecture
Single-file MCP server at `src/index.ts`:
- Env validation at startup (`CLOUDFLARE_API_TOKEN`)
- `cfFetch()` helper wraps `fetch` against `https://api.cloudflare.com/client/v4` with bearer auth and Cloudflare response envelope unwrapping (throws on `success: false`)
- `resolveZoneId()` accepts either a 32-char zone ID or a domain name (looks it up by `?name=`), so tool callers can pass `"example.com"` without first fetching zone IDs
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

## Environment Variables
- `CLOUDFLARE_API_TOKEN` — Cloudflare API token with `Zone:Read` and `Zone:DNS:Edit` permissions (scope to the zones you want to manage, or "All zones"). Create one at https://dash.cloudflare.com/profile/api-tokens.

## Adding to Claude Code
```
claude mcp add cloudflare -s local \
  -e CLOUDFLARE_API_TOKEN="cf-token-here" \
  -- bun /Users/archawat/projects/mcp/mcp-cloudflare/src/index.ts
```
