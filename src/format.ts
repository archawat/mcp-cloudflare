export function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function errorResult(e: unknown) {
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

export function listResult(
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

export function mutationResult(
  action: string,
  entity: string,
  item: Record<string, unknown>
) {
  const id = item?.id ?? "";
  const name = item?.name ? ` (${item.name})` : "";
  return text(`OK: ${entity} ${id} ${action}${name}`);
}

export type BulkListEntry<T> =
  | { zone: string; ok: true; zone_id: string; zone_name: string; records: T[] }
  | { zone: string; ok: false; error: string };

export function bulkListResult<T extends Record<string, unknown>>(
  results: BulkListEntry<T>[],
  columns: ReadonlyArray<string>
) {
  const succeeded = results.filter((r) => r.ok).length;
  const failed = results.length - succeeded;
  const lines: string[] = [
    `Zones: ${results.length} (succeeded: ${succeeded}, failed: ${failed})`,
  ];

  for (const r of results) {
    if (!r.ok) lines.push(`FAIL: ${r.zone} - ${r.error}`);
  }

  const ok = results.filter(
    (r): r is Extract<BulkListEntry<T>, { ok: true }> => r.ok
  );
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
          ...columns.map((c) => cellValue(getNestedValue(rec, c))),
        ];
        lines.push(cells.join("\t"));
      }
    }
  }

  const out = text(lines.join("\n"));
  return failed > 0 ? { ...out, isError: true as const } : out;
}

export type BulkMutationEntry =
  | { ok: true; zone?: string; record: Record<string, unknown> }
  | {
      ok: false;
      zone?: string;
      record_id?: string;
      name?: string;
      error: string;
    };

export function bulkMutationResult(action: string, results: BulkMutationEntry[]) {
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
