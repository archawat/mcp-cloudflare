import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { cfFetch } from "../cf/client.js";
import { resolveZoneId } from "../cf/zone.js";
import { errorResult, errorText, text } from "../format.js";

type ZoneSetting = {
  id: string;
  value: unknown;
  editable?: boolean;
  modified_on?: string | null;
};

const DEFAULT_SETTINGS = [
  "ssl",
  "always_use_https",
  "automatic_https_rewrites",
  "min_tls_version",
] as const;

const settingId = z
  .string()
  .regex(/^[a-z0-9_]+$/, "setting id is lowercase snake_case, e.g. 'ssl'");

function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

export function registerSettingsTools(server: McpServer) {
  server.registerTool(
    "get_zone_settings",
    {
      title: "Get Zone Settings",
      description:
        "Read one or more zone settings (e.g. 'ssl' = SSL/TLS encryption mode off|flexible|full|strict, 'always_use_https', 'min_tls_version'). Accepts a domain name or zone ID. Defaults to ssl, always_use_https, automatic_https_rewrites, min_tls_version. Settings that fail (unknown id, missing token permission) are listed as FAIL lines; the rest still return.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        zone: z.string().describe("Domain name or zone ID."),
        settings: z
          .array(settingId)
          .min(1)
          .max(30)
          .optional()
          .describe(
            "Setting IDs to read (e.g. ['ssl','always_use_https']). Omit for the default TLS/HTTPS set."
          ),
      },
    },
    async ({ zone, settings }) => {
      try {
        const z0 = await resolveZoneId(zone);
        const ids = [...new Set(settings ?? DEFAULT_SETTINGS)];
        const results = await Promise.all(
          ids.map(async (id) => {
            try {
              const data = await cfFetch<ZoneSetting>(
                `/zones/${z0.id}/settings/${id}`
              );
              return { id, ok: true as const, setting: data.result };
            } catch (e) {
              return { id, ok: false as const, error: errorText(e) };
            }
          })
        );
        const failed = results.filter((r) => !r.ok);
        const lines = [
          `Zone: ${z0.name} (${z0.id}) — settings: ${results.length} (failed: ${failed.length})`,
        ];
        for (const r of results) {
          if (!r.ok) lines.push(`FAIL: ${r.id} - ${r.error}`);
        }
        const ok = results.filter((r) => r.ok);
        if (ok.length) {
          lines.push("id\tvalue\teditable\tmodified_on");
          for (const r of ok) {
            const s = r.setting;
            lines.push(
              [s.id, cell(s.value), cell(s.editable), cell(s.modified_on)].join(
                "\t"
              )
            );
          }
        }
        const out = text(lines.join("\n"));
        return failed.length ? { ...out, isError: true as const } : out;
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  server.registerTool(
    "update_zone_setting",
    {
      title: "Update Zone Setting",
      description:
        "Change a single zone setting (PATCH /zones/{id}/settings/{setting_id}). Examples: setting_id='ssl' value='strict'; setting_id='always_use_https' value='off'. Zone-wide effect — affects every host in the zone. Accepts a domain name or zone ID.",
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        zone: z.string().describe("Domain name or zone ID."),
        setting_id: settingId.describe("Setting ID, e.g. 'ssl'."),
        value: z
          .union([
            z.string(),
            z.number(),
            z.boolean(),
            z.record(z.string(), z.unknown()),
            z.array(z.unknown()),
          ])
          .describe(
            "New value, in the shape the setting expects (usually a string like 'on'/'off'/'strict')."
          ),
      },
    },
    async ({ zone, setting_id, value }) => {
      try {
        const z0 = await resolveZoneId(zone);
        const data = await cfFetch<ZoneSetting>(
          `/zones/${z0.id}/settings/${setting_id}`,
          { method: "PATCH", body: JSON.stringify({ value }) }
        );
        return text(
          `OK: ${z0.name} setting ${data.result.id} = ${cell(data.result.value)}`
        );
      } catch (e) {
        return errorResult(e);
      }
    }
  );
}
