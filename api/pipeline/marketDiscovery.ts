/**
 * Market Discovery (pure engine + provider port). No HTTP adapter is shipped: every candidate public source (CoinGecko, CoinPaprika, CryptoCompare,
 * Kraken, Coinbase, KuCoin, Gate, OKX, Binance, Bybit) returned no response from this environment (curl code 000), and availability from Iran was not
 * verified. A provider must be verified (docs/PHASE_E_STATUS.md) before an adapter is written. All thresholds are caller-supplied; none is invented here.
 */
export interface MarketListing {
  symbol: string;            // e.g. BTCUSDT
  baseAsset: string;
  quoteAsset: string;
  quoteVolume24h: number | null;   // null = unknown (never treated as 0 or as sufficient)
  marketCapUsd: number | null;
  firstSeenAt: number | null;      // epoch ms the provider first listed it, if known
  tradable: boolean;
}
export interface DiscoveryOptions {
  quoteAsset: string;
  minQuoteVolume24h: number;
  /** Symbols/bases excluded by the caller (e.g. stablecoins). */
  excludeBases?: readonly string[];
  /** A listing first seen within this window is flagged `isNew`. */
  newListingWindowMs: number;
  now: number;
  /** Upper bound on symbols returned for deep analysis (resource control). */
  maxSelected: number;
}
export type Coverage = "ANALYZABLE" | "VOLUME_UNKNOWN" | "ILLIQUID" | "NOT_TRADABLE" | "EXCLUDED" | "WRONG_QUOTE";
export interface DiscoveredAsset { symbol: string; coverage: Coverage; isNew: boolean; quoteVolume24h: number | null; reason: string }
export interface DiscoveryResult {
  assets: DiscoveredAsset[];
  selected: string[];
  added: string[];
  removed: string[];
  duplicatesDropped: number;
}

export function discoverMarkets(listings: readonly MarketListing[], opts: DiscoveryOptions, previous: readonly string[] = []): DiscoveryResult {
  if (!Number.isFinite(opts.minQuoteVolume24h) || opts.minQuoteVolume24h < 0 || !Number.isInteger(opts.maxSelected) || opts.maxSelected < 0) throw new Error("minQuoteVolume24h and maxSelected must be supplied explicitly (no defaults)");
  const seen = new Set<string>();
  let duplicatesDropped = 0;
  const assets: DiscoveredAsset[] = [];
  for (const l of listings) {
    if (seen.has(l.symbol)) { duplicatesDropped++; continue; }
    seen.add(l.symbol);
    const isNew = l.firstSeenAt !== null && opts.now - l.firstSeenAt >= 0 && opts.now - l.firstSeenAt <= opts.newListingWindowMs;
    const mk = (coverage: Coverage, reason: string): DiscoveredAsset => ({ symbol: l.symbol, coverage, isNew, quoteVolume24h: l.quoteVolume24h, reason });
    if (l.quoteAsset !== opts.quoteAsset) assets.push(mk("WRONG_QUOTE", `quote ${l.quoteAsset} != ${opts.quoteAsset}`));
    else if (opts.excludeBases?.includes(l.baseAsset)) assets.push(mk("EXCLUDED", `base ${l.baseAsset} excluded by caller`));
    else if (!l.tradable) assets.push(mk("NOT_TRADABLE", "provider reports not tradable"));
    else if (l.quoteVolume24h === null || !Number.isFinite(l.quoteVolume24h)) assets.push(mk("VOLUME_UNKNOWN", "24h volume unknown: not analysed"));
    else if (l.quoteVolume24h < opts.minQuoteVolume24h) assets.push(mk("ILLIQUID", `24h volume ${l.quoteVolume24h} < ${opts.minQuoteVolume24h}`));
    else assets.push(mk("ANALYZABLE", "meets caller liquidity floor"));
  }
  // Deep analysis list: analyzable assets, new listings first (so unusual opportunities are not starved), then by volume; capped.
  const analyzable = assets.filter((a) => a.coverage === "ANALYZABLE").sort((a, b) => Number(b.isNew) - Number(a.isNew) || (b.quoteVolume24h ?? 0) - (a.quoteVolume24h ?? 0) || a.symbol.localeCompare(b.symbol));
  const selected = analyzable.slice(0, opts.maxSelected).map((a) => a.symbol);
  const prev = new Set(previous), cur = new Set(selected);
  return { assets, selected, added: selected.filter((s) => !prev.has(s)), removed: previous.filter((s) => !cur.has(s)), duplicatesDropped };
}

/** Rate-limit helper: processes items in batches of `batchSize`, awaiting `pause(ms)` between batches. Pure scheduling; no I/O of its own. */
export async function inBatches<T, R>(items: readonly T[], batchSize: number, pauseMs: number, pause: (ms: number) => Promise<void>, fn: (x: T) => Promise<R>): Promise<R[]> {
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error("batchSize must be an integer >= 1");
  const out: R[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    if (i > 0) await pause(pauseMs);
    out.push(...(await Promise.all(items.slice(i, i + batchSize).map(fn))));
  }
  return out;
}
