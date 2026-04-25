const CF_API = "https://api.cloudflare.com/client/v4";

export type CFResponse<T> = {
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

export async function cfFetch<T>(
  path: string,
  init: RequestInit = {}
): Promise<CFResponse<T>> {
  const res = await fetch(`${CF_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
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
