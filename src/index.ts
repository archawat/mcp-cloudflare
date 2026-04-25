#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;

if (!CLOUDFLARE_API_TOKEN) {
  console.error("Missing required environment variable: CLOUDFLARE_API_TOKEN");
  process.exit(1);
}

const CF_API = "https://api.cloudflare.com/client/v4";

type CFResponse<T> = {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  messages: Array<{ code: number; message: string }>;
  result: T;
  result_info?: {
    page: number;
    per_page: number;
    total_pages: number;
    count: number;
    total_count: number;
  };
};

type Zone = {
  id: string;
  name: string;
  status: string;
  account: { id: string; name: string };
};

type DnsRecord = {
  id: string;
  zone_id: string;
  zone_name: string;
  name: string;
  type: string;
  content: string;
  proxiable: boolean;
  proxied: boolean;
  ttl: number;
  comment?: string | null;
  tags?: string[];
};

async function cfFetch<T>(
  path: string,
  init: RequestInit = {}
): Promise<CFResponse<T>> {
  const res = await fetch(`${CF_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const data = (await res.json()) as CFResponse<T>;
  if (!data.success) {
    const msg = data.errors
      ?.map((e) => `[${e.code}] ${e.message}`)
      .join("; ");
    throw new Error(msg || `Cloudflare API error (HTTP ${res.status})`);
  }
  return data;
}

type ZoneRef = { id: string; name: string };
type ZoneCache = Map<string, Promise<ZoneRef>>;

async function resolveZoneId(
  zone: string,
  cache?: ZoneCache
): Promise<ZoneRef> {
  if (cache) {
    const existing = cache.get(zone);
    if (existing) return existing;
    const p = doResolveZoneId(zone);
    cache.set(zone, p);
    return p;
  }
  return doResolveZoneId(zone);
}

async function doResolveZoneId(zone: string): Promise<ZoneRef> {
  if (/^[a-f0-9]{32}$/i.test(zone)) {
    const data = await cfFetch<Zone>(`/zones/${zone}`);
    return { id: data.result.id, name: data.result.name };
  }
  const data = await cfFetch<Zone[]>(
    `/zones?name=${encodeURIComponent(zone)}`
  );
  if (!data.result.length) {
    throw new Error(`No zone found matching "${zone}"`);
  }
  return { id: data.result[0]!.id, name: data.result[0]!.name };
}

async function fetchDnsRecords(
  zoneId: string,
  filters: { type?: string; name?: string },
  pagination: { per_page: number; page?: number }
): Promise<{
  records: DnsRecord[];
  result_info: CFResponse<DnsRecord[]>["result_info"];
}> {
  const base = new URLSearchParams();
  if (filters.type) base.set("type", filters.type);
  if (filters.name) base.set("name", filters.name);
  base.set("per_page", String(pagination.per_page));

  if (pagination.page !== undefined) {
    base.set("page", String(pagination.page));
    const data = await cfFetch<DnsRecord[]>(
      `/zones/${zoneId}/dns_records?${base.toString()}`
    );
    return { records: data.result, result_info: data.result_info };
  }

  base.set("page", "1");
  const first = await cfFetch<DnsRecord[]>(
    `/zones/${zoneId}/dns_records?${base.toString()}`
  );
  const info = first.result_info;
  if (!info || info.total_pages <= 1) {
    return { records: first.result, result_info: info };
  }
  const rest = await Promise.all(
    Array.from({ length: info.total_pages - 1 }, (_, i) => {
      const p = new URLSearchParams(base);
      p.set("page", String(i + 2));
      return cfFetch<DnsRecord[]>(
        `/zones/${zoneId}/dns_records?${p.toString()}`
      );
    })
  );
  const records = [first.result, ...rest.map((r) => r.result)].flat();
  return {
    records,
    result_info: { ...info, page: 1, count: records.length },
  };
}

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function errorResult(e: unknown) {
  return {
    content: [{ type: "text" as const, text: `Failed: ${errorText(e)}` }],
    isError: true as const,
  };
}

function cellValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  if (!path.includes(".")) return obj[path];
  let current: unknown = obj;
  for (const key of path.split(".")) {
    if (current === null || current === undefined || typeof current !== "object")
      return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function listResult(
  items: ReadonlyArray<Record<string, unknown>>,
  columns: ReadonlyArray<string>,
  total?: number
) {
  if (items.length === 0) return text("Total: 0\nNo items found.");
  const header = columns.join("\t");
  const rows = items.map((item) =>
    columns.map((col) => cellValue(getNestedValue(item, col))).join("\t")
  );
  return text(`Total: ${total ?? items.length}\n${header}\n${rows.join("\n")}`);
}

function mutationResult(
  action: string,
  entity: string,
  item: Record<string, unknown>
) {
  const id = item?.id ?? "";
  const name = item?.name ? ` (${item.name})` : "";
  return text(`OK: ${entity} ${id} ${action}${name}`);
}

type BulkListEntry =
  | { zone: string; ok: true; zone_id: string; zone_name: string; records: DnsRecord[] }
  | { zone: string; ok: false; error: string };

function bulkListResult(results: BulkListEntry[], columns: ReadonlyArray<string>) {
  const succeeded = results.filter((r) => r.ok).length;
  const failed = results.length - succeeded;
  const lines: string[] = [
    `Zones: ${results.length} (succeeded: ${succeeded}, failed: ${failed})`,
  ];

  for (const r of results) {
    if (!r.ok) lines.push(`FAIL: ${r.zone} - ${r.error}`);
  }

  const ok = results.filter((r): r is Extract<BulkListEntry, { ok: true }> => r.ok);
  const totalRecords = ok.reduce((s, r) => s + r.records.length, 0);

  if (totalRecords === 0) {
    lines.push("\nRecords: 0");
  } else {
    lines.push(`\nRecords: ${totalRecords}`);
    lines.push(["zone", ...columns].join("\t"));
    for (const r of ok) {
      for (const rec of r.records) {
        const cells = [
          r.zone_name,
          ...columns.map((c) =>
            cellValue(getNestedValue(rec as unknown as Record<string, unknown>, c))
          ),
        ];
        lines.push(cells.join("\t"));
      }
    }
  }

  const out = text(lines.join("\n"));
  return failed > 0 ? { ...out, isError: true as const } : out;
}

type BulkMutationEntry =
  | { ok: true; zone?: string; record: Record<string, unknown> }
  | {
      ok: false;
      zone?: string;
      record_id?: string;
      name?: string;
      error: string;
    };

function bulkMutationResult(action: string, results: BulkMutationEntry[]) {
  const succeeded = results.filter((r) => r.ok).length;
  const failed = results.length - succeeded;
  const lines: string[] = [`Succeeded: ${succeeded}, Failed: ${failed}`];
  for (const r of results) {
    if (r.ok) {
      const id = r.record.id ?? "";
      const name = r.record.name ? ` (${r.record.name})` : "";
      const zone = r.zone ? `${r.zone}/` : "";
      lines.push(`OK: ${zone}${id} ${action}${name}`);
    } else {
      const ref = r.record_id ?? r.name ?? "?";
      const zone = r.zone ? `${r.zone}/` : "";
      lines.push(`FAIL: ${zone}${ref} - ${r.error}`);
    }
  }
  const out = text(lines.join("\n"));
  return failed > 0 ? { ...out, isError: true as const } : out;
}

const ZONE_COLUMNS = ["id", "name", "status", "account.name"] as const;
const DNS_COLUMNS = ["id", "type", "name", "content", "proxied", "ttl"] as const;

const server = new McpServer({
  name: "mcp-cloudflare",
  version: "1.1.0",
});

server.registerTool(
  "list_zones",
  {
    title: "List Zones",
    description:
      "List all Cloudflare zones (domains) the API token can access. Useful to discover which sites/domains are available to manage.",
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      name: z
        .string()
        .optional()
        .describe("Optional exact domain name filter (e.g. 'example.com')."),
      per_page: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Results per page (1-50, default 20)."),
      page: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Page number (default 1)."),
    },
  },
  async ({ name, per_page, page }) => {
    try {
      const params = new URLSearchParams();
      if (name) params.set("name", name);
      if (per_page) params.set("per_page", String(per_page));
      if (page) params.set("page", String(page));
      const qs = params.toString();
      const data = await cfFetch<Zone[]>(`/zones${qs ? `?${qs}` : ""}`);
      return listResult(
        data.result as unknown as Record<string, unknown>[],
        ZONE_COLUMNS,
        data.result_info?.total_count
      );
    } catch (e) {
      return errorResult(e);
    }
  }
);

server.registerTool(
  "list_dns_records",
  {
    title: "List DNS Records",
    description:
      "List DNS records for a zone. Accepts either a domain name (e.g. 'example.com') or a zone ID. Optional filters for record type and name. Auto-paginates across all pages unless 'page' is explicitly set.",
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      zone: z
        .string()
        .describe(
          "Zone identifier: either a domain name (e.g. 'example.com') or a 32-char zone ID."
        ),
      type: z
        .enum(["A", "AAAA", "CNAME", "TXT", "MX", "NS", "SRV", "CAA"])
        .optional()
        .describe("Filter by record type."),
      name: z
        .string()
        .optional()
        .describe(
          "Filter by record name (fully-qualified, e.g. 'www.example.com')."
        ),
      per_page: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Results per page (1-100, default 100)."),
      page: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          "Page number. If omitted, auto-paginates and returns all pages concatenated."
        ),
    },
  },
  async ({ zone, type, name, per_page, page }) => {
    try {
      const { id: zoneId } = await resolveZoneId(zone);
      const { records, result_info } = await fetchDnsRecords(
        zoneId,
        { type, name },
        { per_page: per_page ?? 100, page }
      );
      return listResult(
        records as unknown as Record<string, unknown>[],
        DNS_COLUMNS,
        result_info?.total_count ?? records.length
      );
    } catch (e) {
      return errorResult(e);
    }
  }
);

server.registerTool(
  "bulk_list_dns_records",
  {
    title: "Bulk List DNS Records",
    description:
      "List DNS records across multiple zones in a single call. Same type/name filters apply to every zone. Executes concurrently per-zone and auto-paginates each. Returns a flat TSV with a 'zone' column plus per-zone failures.",
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      zones: z
        .array(z.string())
        .min(1)
        .describe("Array of domain names or 32-char zone IDs."),
      type: z
        .enum(["A", "AAAA", "CNAME", "TXT", "MX", "NS", "SRV", "CAA"])
        .optional()
        .describe("Filter applied to every zone."),
      name: z
        .string()
        .optional()
        .describe("Fully-qualified name filter applied to every zone."),
      per_page: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Results per page (1-100, default 100)."),
    },
  },
  async ({ zones, type, name, per_page }) => {
    const cache: ZoneCache = new Map();
    const results = await Promise.all(
      zones.map(async (z): Promise<BulkListEntry> => {
        try {
          const ref = await resolveZoneId(z, cache);
          const { records } = await fetchDnsRecords(
            ref.id,
            { type, name },
            { per_page: per_page ?? 100 }
          );
          return {
            zone: z,
            ok: true,
            zone_id: ref.id,
            zone_name: ref.name,
            records,
          };
        } catch (e) {
          return { zone: z, ok: false, error: errorText(e) };
        }
      })
    );
    return bulkListResult(results, DNS_COLUMNS);
  }
);

server.registerTool(
  "create_a_record",
  {
    title: "Create A Record",
    description:
      "Create an A (IPv4) DNS record in the given zone. Proxy is OFF by default — set 'proxied: true' to route traffic through the Cloudflare proxy.",
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      zone: z
        .string()
        .describe("Domain name (e.g. 'example.com') or 32-char zone ID."),
      name: z
        .string()
        .describe(
          "Record name. Use '@' for apex, a subdomain label (e.g. 'www'), or a fully-qualified name (e.g. 'www.example.com')."
        ),
      ip: z.string().describe("IPv4 address (e.g. '192.0.2.1')."),
      proxied: z
        .boolean()
        .optional()
        .describe(
          "Proxy through Cloudflare. Defaults to false (DNS-only, grey cloud)."
        ),
      ttl: z
        .number()
        .int()
        .optional()
        .describe(
          "TTL in seconds. 1 = automatic. Ignored when proxied is true. Default 1 (auto)."
        ),
      comment: z.string().optional().describe("Optional comment for the record."),
    },
  },
  async ({ zone, name, ip, proxied, ttl, comment }) => {
    try {
      const { id: zoneId } = await resolveZoneId(zone);
      const body = {
        type: "A",
        name,
        content: ip,
        proxied: proxied ?? false,
        ttl: ttl ?? 1,
        ...(comment ? { comment } : {}),
      };
      const data = await cfFetch<DnsRecord>(
        `/zones/${zoneId}/dns_records`,
        {
          method: "POST",
          body: JSON.stringify(body),
        }
      );
      return mutationResult(
        "created",
        "A record",
        data.result as unknown as Record<string, unknown>
      );
    } catch (e) {
      return errorResult(e);
    }
  }
);

server.registerTool(
  "create_cname_record",
  {
    title: "Create CNAME Record",
    description:
      "Create a CNAME DNS record in the given zone. Proxy is OFF by default — set 'proxied: true' to route traffic through the Cloudflare proxy.",
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      zone: z
        .string()
        .describe("Domain name (e.g. 'example.com') or 32-char zone ID."),
      name: z
        .string()
        .describe(
          "Record name. Use '@' for apex, a subdomain label (e.g. 'www'), or a fully-qualified name."
        ),
      target: z
        .string()
        .describe("Target hostname (e.g. 'app.example.net')."),
      proxied: z
        .boolean()
        .optional()
        .describe(
          "Proxy through Cloudflare. Defaults to false (DNS-only, grey cloud)."
        ),
      ttl: z
        .number()
        .int()
        .optional()
        .describe(
          "TTL in seconds. 1 = automatic. Ignored when proxied is true. Default 1 (auto)."
        ),
      comment: z.string().optional().describe("Optional comment for the record."),
    },
  },
  async ({ zone, name, target, proxied, ttl, comment }) => {
    try {
      const { id: zoneId } = await resolveZoneId(zone);
      const body = {
        type: "CNAME",
        name,
        content: target,
        proxied: proxied ?? false,
        ttl: ttl ?? 1,
        ...(comment ? { comment } : {}),
      };
      const data = await cfFetch<DnsRecord>(
        `/zones/${zoneId}/dns_records`,
        {
          method: "POST",
          body: JSON.stringify(body),
        }
      );
      return mutationResult(
        "created",
        "CNAME record",
        data.result as unknown as Record<string, unknown>
      );
    } catch (e) {
      return errorResult(e);
    }
  }
);

server.registerTool(
  "toggle_proxy",
  {
    title: "Toggle Proxy",
    description:
      "Turn the Cloudflare proxy (orange cloud) on or off for an existing DNS record. Identify the record by zone + name (and optional type) or by record_id.",
    annotations: {
      readOnlyHint: false,
      idempotentHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      zone: z
        .string()
        .describe("Domain name (e.g. 'example.com') or 32-char zone ID."),
      record_id: z
        .string()
        .optional()
        .describe("DNS record ID. If omitted, provide 'name' instead."),
      name: z
        .string()
        .optional()
        .describe(
          "Fully-qualified record name (e.g. 'www.example.com'). Used when record_id is not provided."
        ),
      type: z
        .enum(["A", "AAAA", "CNAME"])
        .optional()
        .describe("Record type filter when looking up by name (proxyable types only)."),
      proxied: z
        .boolean()
        .describe("true = proxy ON (orange), false = proxy OFF (grey, DNS-only)."),
    },
  },
  async ({ zone, record_id, name, type, proxied }) => {
    try {
      const { id: zoneId } = await resolveZoneId(zone);
      let target: DnsRecord | undefined;

      if (record_id) {
        const got = await cfFetch<DnsRecord>(
          `/zones/${zoneId}/dns_records/${record_id}`
        );
        target = got.result;
      } else {
        if (!name) {
          throw new Error("Provide either 'record_id' or 'name'.");
        }
        const params = new URLSearchParams({ name });
        if (type) params.set("type", type);
        const list = await cfFetch<DnsRecord[]>(
          `/zones/${zoneId}/dns_records?${params.toString()}`
        );
        const candidates = list.result.filter((r) =>
          ["A", "AAAA", "CNAME"].includes(r.type)
        );
        if (candidates.length === 0) {
          throw new Error(`No proxyable record found for '${name}'.`);
        }
        if (candidates.length > 1) {
          throw new Error(
            `Multiple records match '${name}': ${candidates
              .map((r) => `${r.type} ${r.id}`)
              .join(", ")}. Specify 'type' or 'record_id'.`
          );
        }
        target = candidates[0]!;
      }

      if (!target.proxiable) {
        throw new Error(
          `Record '${target.name}' (${target.type}) is not proxyable.`
        );
      }

      const updated = await cfFetch<DnsRecord>(
        `/zones/${zoneId}/dns_records/${target.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({ proxied }),
        }
      );

      return mutationResult(
        `proxy ${proxied ? "ON" : "OFF"}`,
        "Record",
        updated.result as unknown as Record<string, unknown>
      );
    } catch (e) {
      return errorResult(e);
    }
  }
);

server.registerTool(
  "bulk_toggle_proxy",
  {
    title: "Bulk Toggle Proxy",
    description:
      "Flip the Cloudflare proxy on/off for many records in a single call. Each target identifies a record by zone + (record_id OR name [+ optional type]). All targets use the same 'proxied' value. Executes concurrently; returns per-target ok/error.",
    annotations: {
      readOnlyHint: false,
      idempotentHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      proxied: z
        .boolean()
        .describe(
          "true = proxy ON (orange) for all targets, false = proxy OFF (grey, DNS-only)."
        ),
      targets: z
        .array(
          z.object({
            zone: z
              .string()
              .describe("Domain name or 32-char zone ID for this target."),
            record_id: z
              .string()
              .optional()
              .describe(
                "DNS record ID. If omitted, 'name' must be provided."
              ),
            name: z
              .string()
              .optional()
              .describe(
                "Fully-qualified record name. Used when record_id is not provided."
              ),
            type: z
              .enum(["A", "AAAA", "CNAME"])
              .optional()
              .describe(
                "Record type filter when looking up by name (proxyable types only)."
              ),
          })
        )
        .min(1)
        .describe("One entry per record to flip."),
    },
  },
  async ({ proxied, targets }) => {
    const cache: ZoneCache = new Map();
    const results = await Promise.all(
      targets.map(async (t): Promise<BulkMutationEntry> => {
        try {
          const { id: zoneId } = await resolveZoneId(t.zone, cache);
          let recordId = t.record_id;

          if (!recordId) {
            if (!t.name) {
              throw new Error("Provide either 'record_id' or 'name'.");
            }
            const params = new URLSearchParams({ name: t.name });
            if (t.type) params.set("type", t.type);
            const list = await cfFetch<DnsRecord[]>(
              `/zones/${zoneId}/dns_records?${params.toString()}`
            );
            const candidates = list.result.filter((r) =>
              ["A", "AAAA", "CNAME"].includes(r.type)
            );
            if (candidates.length === 0) {
              throw new Error(`No proxyable record found for '${t.name}'.`);
            }
            if (candidates.length > 1) {
              throw new Error(
                `Multiple records match '${t.name}': ${candidates
                  .map((r) => `${r.type} ${r.id}`)
                  .join(", ")}. Specify 'type' or 'record_id'.`
              );
            }
            const picked = candidates[0]!;
            if (!picked.proxiable) {
              throw new Error(
                `Record '${picked.name}' (${picked.type}) is not proxyable.`
              );
            }
            recordId = picked.id;
          }

          const updated = await cfFetch<DnsRecord>(
            `/zones/${zoneId}/dns_records/${recordId}`,
            {
              method: "PATCH",
              body: JSON.stringify({ proxied }),
            }
          );

          return {
            ok: true,
            zone: t.zone,
            record: updated.result as unknown as Record<string, unknown>,
          };
        } catch (e) {
          return {
            ok: false,
            zone: t.zone,
            record_id: t.record_id,
            name: t.name,
            error: errorText(e),
          };
        }
      })
    );
    return bulkMutationResult(`proxy ${proxied ? "ON" : "OFF"}`, results);
  }
);

server.registerTool(
  "update_dns_record",
  {
    title: "Update DNS Record",
    description:
      "Update fields on an existing DNS record (content, ttl, comment, or proxied). Only supplied fields are changed.",
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      zone: z
        .string()
        .describe("Domain name (e.g. 'example.com') or 32-char zone ID."),
      record_id: z.string().describe("DNS record ID to update."),
      content: z
        .string()
        .optional()
        .describe("New content (IP for A/AAAA, hostname for CNAME, etc.)."),
      ttl: z
        .number()
        .int()
        .optional()
        .describe("New TTL in seconds. 1 = automatic."),
      proxied: z
        .boolean()
        .optional()
        .describe("Proxy through Cloudflare (A/AAAA/CNAME only)."),
      comment: z.string().optional().describe("Optional comment."),
    },
  },
  async ({ zone, record_id, content, ttl, proxied, comment }) => {
    try {
      const { id: zoneId } = await resolveZoneId(zone);
      const body: Record<string, unknown> = {};
      if (content !== undefined) body.content = content;
      if (ttl !== undefined) body.ttl = ttl;
      if (proxied !== undefined) body.proxied = proxied;
      if (comment !== undefined) body.comment = comment;
      if (Object.keys(body).length === 0) {
        throw new Error("Provide at least one field to update.");
      }
      const data = await cfFetch<DnsRecord>(
        `/zones/${zoneId}/dns_records/${record_id}`,
        {
          method: "PATCH",
          body: JSON.stringify(body),
        }
      );
      return mutationResult(
        "updated",
        "Record",
        data.result as unknown as Record<string, unknown>
      );
    } catch (e) {
      return errorResult(e);
    }
  }
);

server.registerTool(
  "bulk_update_dns_record",
  {
    title: "Bulk Update DNS Records",
    description:
      "Apply PATCH updates to many DNS records in a single call. Each update targets a record by zone + record_id with per-item fields (content/ttl/proxied/comment). Executes concurrently; returns per-update ok/error.",
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      updates: z
        .array(
          z.object({
            zone: z
              .string()
              .describe("Domain name or 32-char zone ID for this record."),
            record_id: z.string().describe("DNS record ID to update."),
            content: z
              .string()
              .optional()
              .describe("New content (IP for A/AAAA, hostname for CNAME, etc.)."),
            ttl: z
              .number()
              .int()
              .optional()
              .describe("New TTL in seconds. 1 = automatic."),
            proxied: z
              .boolean()
              .optional()
              .describe("Proxy through Cloudflare (A/AAAA/CNAME only)."),
            comment: z.string().optional().describe("Optional comment."),
          })
        )
        .min(1)
        .describe("One entry per record to update."),
    },
  },
  async ({ updates }) => {
    const cache: ZoneCache = new Map();
    const results = await Promise.all(
      updates.map(async (u): Promise<BulkMutationEntry> => {
        try {
          const { id: zoneId } = await resolveZoneId(u.zone, cache);
          const body: Record<string, unknown> = {};
          if (u.content !== undefined) body.content = u.content;
          if (u.ttl !== undefined) body.ttl = u.ttl;
          if (u.proxied !== undefined) body.proxied = u.proxied;
          if (u.comment !== undefined) body.comment = u.comment;
          if (Object.keys(body).length === 0) {
            throw new Error("Provide at least one field to update.");
          }
          const data = await cfFetch<DnsRecord>(
            `/zones/${zoneId}/dns_records/${u.record_id}`,
            {
              method: "PATCH",
              body: JSON.stringify(body),
            }
          );
          return {
            ok: true,
            zone: u.zone,
            record: data.result as unknown as Record<string, unknown>,
          };
        } catch (e) {
          return {
            ok: false,
            zone: u.zone,
            record_id: u.record_id,
            error: errorText(e),
          };
        }
      })
    );
    return bulkMutationResult("updated", results);
  }
);

server.registerTool(
  "delete_dns_record",
  {
    title: "Delete DNS Record",
    description:
      "Delete a DNS record by ID. This is destructive and cannot be undone from this tool.",
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
      destructiveHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      zone: z
        .string()
        .describe("Domain name (e.g. 'example.com') or 32-char zone ID."),
      record_id: z.string().describe("DNS record ID to delete."),
    },
  },
  async ({ zone, record_id }) => {
    try {
      const { id: zoneId } = await resolveZoneId(zone);
      const data = await cfFetch<{ id: string }>(
        `/zones/${zoneId}/dns_records/${record_id}`,
        { method: "DELETE" }
      );
      return mutationResult(
        "deleted",
        "Record",
        data.result as unknown as Record<string, unknown>
      );
    } catch (e) {
      return errorResult(e);
    }
  }
);

await server.connect(new StdioServerTransport());
