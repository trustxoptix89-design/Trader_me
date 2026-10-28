const TIMEOUT_MS = 12_000;
const cache = new Map<string, { at: number; value: unknown }>();

export class MarketDataError extends Error {
  source: string;
  causeMessage?: string;
  constructor(source: string, message: string, causeMessage?: string) {
    super(message); this.name = "MarketDataError"; this.source = source; this.causeMessage = causeMessage;
  }
}

/** Public, read-only JSON GET with timeout and a short cache. Failures surface as MarketDataError — never substitute data. */
export async function getJson<T>(url: string, source: string, cacheMs = 0): Promise<T> {
  const hit = cache.get(url);
  if (cacheMs && hit && Date.now() - hit.at < cacheMs) return hit.value as T;
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "application/json", "user-agent": "Mozilla/5.0 (compatible; Sarmaye/1.0; market-data-reader)" } });
  } catch (error) {
    throw new MarketDataError(source, `اتصال به ${source} برقرار نشد`, error instanceof Error ? error.message : String(error));
  }
  if (!response.ok) {
    const body = (await response.text()).slice(0, 300);
    throw new MarketDataError(source, `${source} با کد ${response.status} پاسخ داد`, body);
  }
  const data = await response.json() as T;
  if (cacheMs) cache.set(url, { at: Date.now(), value: data });
  return data;
}
