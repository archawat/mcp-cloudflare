import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CFError, cfFetch } from "../cf/client.js";
import { resolveZoneId, type ZoneRef } from "../cf/zone.js";
import { errorResult, text } from "../format.js";

type Rule = {
  id: string;
  ref?: string;
  version?: string;
  last_updated?: string;
  description?: string;
  enabled?: boolean;
  expression: string;
  action: string;
  action_parameters?: Record<string, unknown>;
  [key: string]: unknown;
};

type Ruleset = {
  id: string;
  name?: string;
  phase: string;
  version?: string;
  rules?: Rule[];
};

const PHASES = [
  "http_config_settings",
  "http_request_dynamic_redirect",
  "http_request_firewall_custom",
  "http_request_origin",
  "http_request_cache_settings",
  "http_request_transform",
  "http_response_headers_transform",
] as const;

const phaseSchema = z
  .enum(PHASES)
  .describe(
    "Ruleset phase: http_config_settings = Configuration Rules, http_request_dynamic_redirect = Single Redirects, http_request_firewall_custom = WAF custom rules, http_request_origin = Origin Rules, http_request_cache_settings = Cache Rules, http_request_transform = URL Rewrite, http_response_headers_transform = Response Header Transform."
  );

const ruleIdSchema = z
  .string()
  .regex(/^[a-f0-9]{32}$/i, "rule_id is a 32-char hex id from list_phase_rules");

const actionParamsSchema = z
  .record(z.string(), z.unknown())
  .describe(
    "Action parameters object, e.g. set_config {\"ssl\":\"strict\"}; redirect {\"from_value\":{\"status_code\":301,\"target_url\":{\"expression\":\"concat(\\\"https://\\\", http.host, http.request.uri.path)\"},\"preserve_query_string\":true}}; skip {\"ruleset\":\"current\"}."
  );

function entrypointPath(zoneId: string, phase: string) {
  return `/zones/${zoneId}/rulesets/phases/${phase}/entrypoint`;
}

// A phase with no rules yet has no entrypoint ruleset — the API answers 404.
async function getEntrypoint(
  zoneId: string,
  phase: string
): Promise<Ruleset | null> {
  try {
    const data = await cfFetch<Ruleset>(entrypointPath(zoneId, phase));
    return data.result;
  } catch (e) {
    if (e instanceof CFError && e.status === 404) return null;
    throw e;
  }
}

async function requireRule(
  z0: ZoneRef,
  phase: string,
  ruleId: string
): Promise<{ ruleset: Ruleset; rule: Rule }> {
  const ruleset = await getEntrypoint(z0.id, phase);
  const rule = ruleset?.rules?.find((r) => r.id === ruleId);
  if (!ruleset || !rule) {
    throw new Error(`Rule ${ruleId} not found in ${phase} of ${z0.name}`);
  }
  return { ruleset, rule };
}

// Keep TSV rows on one line: expressions typed in the dashboard may span lines.
function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return s.replace(/[\t\r\n]+/g, " ");
}

function ruleLabel(r: Rule) {
  return r.description ? ` (${r.description})` : "";
}

export function registerRulesetTools(server: McpServer) {
  server.registerTool(
    "list_phase_rules",
    {
      title: "List Phase Rules",
      description:
        "List the active rules of a zone's entrypoint ruleset for one phase (Configuration Rules, Single Redirects, WAF custom rules, …), in evaluation order. Returns each rule's id, enabled, action, description, expression and action_parameters. A phase with no rules yet returns an empty list. Accepts a domain name or zone ID.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        zone: z.string().describe("Domain name or zone ID."),
        phase: phaseSchema,
      },
    },
    async ({ zone, phase }) => {
      try {
        const z0 = await resolveZoneId(zone);
        const rs = await getEntrypoint(z0.id, phase);
        const rules = rs?.rules ?? [];
        const head = rs
          ? `Zone: ${z0.name} — phase ${phase} — ruleset ${rs.id} — rules: ${rules.length}`
          : `Zone: ${z0.name} — phase ${phase} — no entrypoint ruleset (rules: 0)`;
        if (!rules.length) return text(head);
        const cols = [
          "id",
          "enabled",
          "action",
          "description",
          "expression",
          "action_parameters",
        ] as const;
        const rows = rules.map((r) => cols.map((c) => cell(r[c])).join("\t"));
        return text([head, cols.join("\t"), ...rows].join("\n"));
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  server.registerTool(
    "create_phase_rule",
    {
      title: "Create Phase Rule",
      description:
        "Add ONE rule to a zone's phase entrypoint ruleset without touching existing rules (POST …/rulesets/{id}/rules). If the phase has no entrypoint yet, it is created holding just this rule. Actions by phase: http_config_settings → set_config; http_request_dynamic_redirect → redirect; http_request_firewall_custom → block | challenge | js_challenge | managed_challenge | log | skip. Accepts a domain name or zone ID.",
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        zone: z.string().describe("Domain name or zone ID."),
        phase: phaseSchema,
        description: z.string().min(1).max(500).describe("Rule name shown in the dashboard."),
        expression: z
          .string()
          .min(1)
          .describe("Wirefilter expression, e.g. (http.host eq \"app.example.com\")."),
        action: z.string().min(1).describe("Rule action (see tool description)."),
        action_parameters: actionParamsSchema.optional(),
        enabled: z.boolean().optional().describe("Default true."),
        position: z
          .union([
            z.object({ before: ruleIdSchema }).strict(),
            z.object({ after: ruleIdSchema }).strict(),
            z.object({ index: z.number().int().min(1) }).strict(),
          ])
          .optional()
          .describe(
            "Where to insert: {before: rule_id} | {after: rule_id} | {index: n} (1-based). Default: last. Ignored when the entrypoint is newly created."
          ),
      },
    },
    async ({ zone, phase, description, expression, action, action_parameters, enabled, position }) => {
      try {
        const z0 = await resolveZoneId(zone);
        const rule = {
          description,
          expression,
          action,
          enabled: enabled ?? true,
          ...(action_parameters ? { action_parameters } : {}),
        };
        const existing = await getEntrypoint(z0.id, phase);
        let result: Ruleset;
        let created: Rule | undefined;
        if (!existing) {
          // Safe to PUT only because the phase has no entrypoint (and so no rules).
          const data = await cfFetch<Ruleset>(entrypointPath(z0.id, phase), {
            method: "PUT",
            body: JSON.stringify({ rules: [rule] }),
          });
          result = data.result;
          created = result.rules?.[0];
        } else {
          const before = new Set((existing.rules ?? []).map((r) => r.id));
          const data = await cfFetch<Ruleset>(
            `/zones/${z0.id}/rulesets/${existing.id}/rules`,
            {
              method: "POST",
              body: JSON.stringify({ ...rule, ...(position ? { position } : {}) }),
            }
          );
          result = data.result;
          created = result.rules?.find((r) => !before.has(r.id));
        }
        return text(
          `OK: ${z0.name} ${phase} rule ${created?.id ?? "?"} created${created ? ruleLabel(created) : ""} — ruleset ${result.id} now has ${result.rules?.length ?? 0} rules`
        );
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  server.registerTool(
    "update_phase_rule",
    {
      title: "Update Phase Rule",
      description:
        "Patch ONE existing rule in a zone's phase entrypoint ruleset. Only the fields you pass change; the rest are kept from the current rule (action_parameters, if passed, replaces the whole object). Other rules are untouched. Accepts a domain name or zone ID.",
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        zone: z.string().describe("Domain name or zone ID."),
        phase: phaseSchema,
        rule_id: ruleIdSchema,
        description: z.string().min(1).max(500).optional(),
        expression: z.string().min(1).optional(),
        action: z.string().min(1).optional(),
        action_parameters: actionParamsSchema.optional(),
        enabled: z.boolean().optional(),
      },
    },
    async ({ zone, phase, rule_id, ...fields }) => {
      try {
        const changes = Object.fromEntries(
          Object.entries(fields).filter(([, v]) => v !== undefined)
        );
        if (!Object.keys(changes).length) {
          throw new Error("Nothing to update: pass at least one field");
        }
        const z0 = await resolveZoneId(zone);
        const { ruleset, rule } = await requireRule(z0, phase, rule_id);
        const { id: _id, version: _v, last_updated: _lu, ...current } = rule;
        const data = await cfFetch<Ruleset>(
          `/zones/${z0.id}/rulesets/${ruleset.id}/rules/${rule_id}`,
          { method: "PATCH", body: JSON.stringify({ ...current, ...changes }) }
        );
        const updated = data.result.rules?.find((r) => r.id === rule_id) ?? rule;
        return text(
          `OK: ${z0.name} ${phase} rule ${rule_id} updated${ruleLabel(updated)} — changed: ${Object.keys(changes).join(", ")}`
        );
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  server.registerTool(
    "delete_phase_rule",
    {
      title: "Delete Phase Rule",
      description:
        "Delete ONE rule from a zone's phase entrypoint ruleset (destructive; other rules are untouched). Accepts a domain name or zone ID.",
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,
        destructiveHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        zone: z.string().describe("Domain name or zone ID."),
        phase: phaseSchema,
        rule_id: ruleIdSchema,
      },
    },
    async ({ zone, phase, rule_id }) => {
      try {
        const z0 = await resolveZoneId(zone);
        const { ruleset, rule } = await requireRule(z0, phase, rule_id);
        const data = await cfFetch<Ruleset>(
          `/zones/${z0.id}/rulesets/${ruleset.id}/rules/${rule_id}`,
          { method: "DELETE" }
        );
        return text(
          `OK: ${z0.name} ${phase} rule ${rule_id} deleted${ruleLabel(rule)} — ruleset now has ${data.result.rules?.length ?? 0} rules`
        );
      } catch (e) {
        return errorResult(e);
      }
    }
  );
}
