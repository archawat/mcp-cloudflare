# @archawat/mcp-cloudflare

Model Context Protocol (MCP) server for managing Cloudflare DNS, zone settings, and Rules across multiple zones (domains) from a single API token. Built for bulk workflows — flipping proxy on/off across many records, auditing DNS across zones, and batched record updates — plus reading and editing SSL/HTTPS settings, Configuration Rules, Single Redirects, and WAF custom rules.

## Features

- **Multi-zone from one token** — pass a domain name like `"example.com"` and the server resolves the zone for you. Zone IDs also accepted.
- **Bulk operations** — `bulk_toggle_proxy`, `bulk_update_dns_record`, and `bulk_list_dns_records` run concurrently and share a per-invocation zone-ID cache so repeated zones don't cost extra lookups.
- **Safe defaults** — new A/CNAME records are created with `proxied: false` (DNS-only, grey cloud). Proxy is opt-in.
- **Auto-pagination** — `list_dns_records` fetches every page in parallel unless you ask for a specific one.
- **Per-rule edits** — rule tools add, patch, or delete one rule at a time and never replace a phase's whole ruleset, so rules created in the dashboard are left alone.

## Install

No local install required — use `npx` or `bunx` to run it on demand.

### Claude Code / Claude Desktop (`.mcp.json`)

Via `npx` (Node):

```json
{
  "mcpServers": {
    "cloudflare": {
      "command": "npx",
      "args": ["-y", "@archawat/mcp-cloudflare"],
      "env": { "CLOUDFLARE_API_TOKEN": "cf-token-here" }
    }
  }
}
```

Via `bunx` (Bun):

```json
{
  "mcpServers": {
    "cloudflare": {
      "command": "bunx",
      "args": ["-y", "@archawat/mcp-cloudflare"],
      "env": { "CLOUDFLARE_API_TOKEN": "cf-token-here" }
    }
  }
}
```

### Claude Code CLI

```bash
claude mcp add cloudflare -s user \
  -e CLOUDFLARE_API_TOKEN="cf-token-here" \
  -- npx -y @archawat/mcp-cloudflare
```

### Global install (fastest cold-start)

```bash
npm install -g @archawat/mcp-cloudflare
# or: bun add -g @archawat/mcp-cloudflare
```

The global bin is named `mcp-cloudflare` (unscoped), so:

```json
{
  "mcpServers": {
    "cloudflare": {
      "command": "mcp-cloudflare",
      "env": { "CLOUDFLARE_API_TOKEN": "cf-token-here" }
    }
  }
}
```

## API Token

Create a Cloudflare token at <https://dash.cloudflare.com/profile/api-tokens> with:

- `Zone:Read`
- `Zone:DNS:Edit`

Optional, only for the settings and Rules tools (Read for the `get_`/`list_` tools, Edit for the write tools):

- `Zone Settings` — `get_zone_settings`, `update_zone_setting`
- The permission for each rule type you use — e.g. `Config Rules` (Configuration Rules), `Single Redirect` (Single Redirects), `Zone WAF` (WAF custom rules)

A tool whose permission is missing fails with Cloudflare's authentication error; the DNS tools keep working.

Scope the token to the zones you want to manage, or grant "All zones".

## Tools

| Tool | Purpose |
|---|---|
| `list_zones` | Discover which domains the token can manage. |
| `list_dns_records` | List records in a zone; auto-paginates across all pages unless `page` is set. |
| `bulk_list_dns_records` | List records across many zones in one call. Concurrent per-zone. |
| `create_a_record` | Create an A record. `proxied` defaults to `false`. |
| `create_cname_record` | Create a CNAME record. `proxied` defaults to `false`. |
| `create_txt_record` | Create a TXT record (SPF, DKIM, DMARC, domain verification). |
| `create_mx_record` | Create an MX record for mail routing. `priority` required. |
| `toggle_proxy` | Flip proxy on/off by record ID, or by name (+ optional type). |
| `bulk_toggle_proxy` | Flip proxy for many records in one call (shared `proxied` value). |
| `update_dns_record` | Patch `content`, `ttl`, `proxied`, or `comment` on a record. |
| `bulk_update_dns_record` | Patch many records in one call with per-item fields. |
| `delete_dns_record` | Delete a record by ID. Destructive. |
| `get_zone_settings` | Read zone settings (default: `ssl`, `always_use_https`, `automatic_https_rewrites`, `min_tls_version`). |
| `update_zone_setting` | Change one zone setting, e.g. `ssl` → `strict`. Zone-wide effect. |
| `list_phase_rules` | List a phase's rules in evaluation order. A phase with no rules returns an empty list. |
| `create_phase_rule` | Add one rule to a phase (optional `position`). Creates the phase's ruleset if it doesn't exist yet. |
| `update_phase_rule` | Patch one rule; fields you don't pass keep their current values. |
| `delete_phase_rule` | Delete one rule. Destructive. |

Rule tools take a `phase`:

| Phase | Dashboard name | Typical action |
|---|---|---|
| `http_config_settings` | Configuration Rules | `set_config` |
| `http_request_dynamic_redirect` | Single Redirects | `redirect` |
| `http_request_firewall_custom` | WAF custom rules | `block`, `managed_challenge`, `skip`, … |
| `http_request_origin` | Origin Rules | `route` |
| `http_request_cache_settings` | Cache Rules | `set_cache_settings` |
| `http_request_transform` | URL Rewrite Rules | `rewrite` |
| `http_response_headers_transform` | Response Header Transform Rules | `rewrite` |

All tools accept either a domain name (`"example.com"`) or a 32-char zone ID as the `zone` argument.

### Result shape

Responses are plain text — TSV for lists, one-liners for mutations — to keep token usage low. A single failure in a bulk call doesn't abort the batch.

`list_dns_records`:

```
Total: 2
id	type	name	content	proxied	ttl
abc123	A	www.example.com	1.2.3.4	true	1
def456	CNAME	api.example.com	example.com	false	300
```

`create_*` / `update_dns_record` / `toggle_proxy` / `delete_dns_record`:

```
OK: dns_record abc123 created (www.example.com)
```

`bulk_list_dns_records`:

```
Zones: 2 (succeeded: 1, failed: 1)
FAIL: other.com - No zone found for 'other.com'

Records: 1
zone	id	type	name	content	proxied	ttl
example.com	abc123	A	www.example.com	1.2.3.4	true	1
```

`bulk_toggle_proxy` / `bulk_update_dns_record`:

```
Succeeded: 1, Failed: 1
OK: example.com/abc123 toggled (www.example.com)
FAIL: other.com/www.other.com - No proxyable record found for 'www.other.com'.
```

`get_zone_settings`:

```
Zone: example.com (023e105f4ecef8ad9ca31a8372d0c353) — settings: 2 (failed: 0)
id	value	editable	modified_on
ssl	strict	true	2026-09-30T08:12:44.123Z
always_use_https	off	true	2026-09-30T08:13:02.456Z
```

`list_phase_rules`:

```
Zone: example.com — phase http_config_settings — ruleset 2f2feab2026849078ba485f918791bdc — rules: 1
id	enabled	action	description	expression	action_parameters
3a03d665bac047339bb530ecb439a90d	true	set_config	app strict SSL	(http.host eq "app.example.com")	{"ssl":"strict"}
```

`create_phase_rule` / `update_phase_rule` / `delete_phase_rule`:

```
OK: example.com http_config_settings rule 3a03d665bac047339bb530ecb439a90d created (app strict SSL) — ruleset 2f2feab2026849078ba485f918791bdc now has 1 rules
```

Errors return `Failed: <message>` with `isError: true`. Bulk tools also set `isError: true` whenever any item fails, while still returning every result.

## Development

Requires Bun (recommended) or Node 18+.

```bash
bun install
bun run dev         # run src/index.ts with --watch
bun run start       # run src/index.ts once
bun run typecheck   # tsc --noEmit
bun run build       # emit dist/ for publishing
```

To run the dev copy as the MCP server instead of the published package, point `.mcp.json` at your local build:

```json
{
  "mcpServers": {
    "cloudflare": {
      "command": "bun",
      "args": ["/abs/path/to/mcp-cloudflare/src/index.ts"],
      "env": { "CLOUDFLARE_API_TOKEN": "cf-token-here" }
    }
  }
}
```

The server speaks stdio — your MCP client spawns the process and communicates over stdin/stdout.

## License

MIT
