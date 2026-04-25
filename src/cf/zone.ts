import { cfFetch } from "./client.js";

export type Zone = {
  id: string;
  name: string;
  status: string;
  account: { id: string; name: string };
};

export type ZoneRef = { id: string; name: string };
export type ZoneCache = Map<string, Promise<ZoneRef>>;

export async function resolveZoneId(
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
