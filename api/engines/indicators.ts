import type { Candle, MarketMetrics, MarketSnapshot } from "@contracts/types";
import { sma, emaSeries, rsiSeries, atrSeries, adxSeries, macdHistogram, macdSeries, vwapSeries, swingLevels } from "@contracts/indicators";

export { sma, emaSeries, rsiSeries, atrSeries, adxSeries, macdHistogram, macdSeries, vwapSeries, swingLevels };

export function trendOf(candles: Candle[]): MarketMetrics["trend"] {
  const closes = candles.map((c) => c.close);
  const fast = emaSeries(closes, 20).at(-1), slow = emaSeries(closes, 50).at(-1);
  if (fast == null || slow == null) return "unknown";
  const threshold = (atrSeries(candles).at(-1) ?? 0) * 0.15;
  if (fast > slow + threshold) return "bullish";
  if (fast < slow - threshold) return "bearish";
  return "range";
}

export function structureOf(candles: Candle[]): MarketMetrics["structure"] {
  if (candles.length < 12) return "unknown";
  const recent = candles.slice(-12), midpoint = 6;
  const firstHigh = Math.max(...recent.slice(0, midpoint).map((c) => c.high));
  const secondHigh = Math.max(...recent.slice(midpoint).map((c) => c.high));
  const firstLow = Math.min(...recent.slice(0, midpoint).map((c) => c.low));
  const secondLow = Math.min(...recent.slice(midpoint).map((c) => c.low));
  if (secondHigh > firstHigh && secondLow > firstLow) return "higher-highs";
  if (secondHigh < firstHigh && secondLow < firstLow) return "lower-lows";
  return "mixed";
}

export function computeMetrics(snapshot: MarketSnapshot): MarketMetrics {
  const candles = snapshot.candles;
  const closes = candles.map((c) => c.close), volumes = candles.map((c) => c.volume);
  const price = closes.at(-1) ?? snapshot.derivatives.markPrice ?? 0;
  const atr = atrSeries(candles).at(-1) ?? null;
  const returns = closes.slice(1).map((v, i) => Math.log(v / closes[i]));
  const mean = returns.reduce((a, b) => a + b, 0) / Math.max(1, returns.length);
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, returns.length - 1);
  const avgVolume = sma(volumes.slice(0, -1), 20);
  const recent = candles.slice(-48);
  return {
    price, ema20: emaSeries(closes, 20).at(-1) ?? null, ema50: emaSeries(closes, 50).at(-1) ?? null,
    ema200: emaSeries(closes, 200).at(-1) ?? null, rsi14: rsiSeries(closes).at(-1) ?? null,
    atr14: atr, atrPct: atr && price ? atr / price * 100 : null, adx14: adxSeries(candles).at(-1) ?? null,
    macdHistogram: macdHistogram(closes), volumeRatio: avgVolume ? volumes.at(-1)! / avgVolume : null,
    realizedVolatilityPct: Math.sqrt(variance) * Math.sqrt(96) * 100,
    support: recent.length ? Math.min(...recent.map((c) => c.low)) : null,
    resistance: recent.length ? Math.max(...recent.map((c) => c.high)) : null,
    trend: trendOf(candles), structure: structureOf(candles),
    higherTrend: snapshot.higherTimeframes["4h"]?.length ? trendOf(snapshot.higherTimeframes["4h"]!) : "unknown",
    liquidityUsd: candles.at(-1)?.quoteVolume ?? (candles.at(-1) ? candles.at(-1)!.close * candles.at(-1)!.volume : null),
    priceChangePct: closes.length > 1 ? (price / closes.at(-2)! - 1) * 100 : null,
  };
}
