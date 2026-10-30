/** Minimal public-JSON GET for the ingest cascade. Unlike connectors/http.ts it keeps the HTTP status, because the cascade must report it per source. */
export type FetchLike = typeof fetch;

export class IngestHttpError extends Error {
  /** HTTP status, or null when no response was received (network error / timeout). */
  status: number | null;
  source: string;
  constructor(source: string, status: number | null, message: string) {
    super(message);
    this.name = "IngestHttpError";
    this.source = source;
    this.status = status;
  }
}

export const REQUEST_TIMEOUT_MS = 5_000;

export async function getJson(url: string, source: string, fetchImpl: FetchLike = fetch, timeoutMs = REQUEST_TIMEOUT_MS): Promise<{ status: number; body: unknown }> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json", "user-agent": "Mozilla/5.0 (compatible; Sarmaye/1.0; market-data-reader)" },
    });
  } catch (error) {
    throw new IngestHttpError(source, null, `network error: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    await response.text().catch(() => "");
    throw new IngestHttpError(source, response.status, `HTTP ${response.status}`);
  }
  try {
    return { status: response.status, body: await response.json() };
  } catch {
    throw new IngestHttpError(source, response.status, "response is not valid JSON");
  }
}
