import { DB_TIMEFRAME, PIPELINE_TIMEFRAMES, TF_MS, type LoadRows, type StoredCandle } from "../../pipeline/candleAdapter";
import { TF, retime } from "./governanceFixtures";
import { fiveMinuteBearishFvgLong, range4HAtTop, trendSeries } from "./advancedFixtures";

// DATA CLASS: SYNTHETIC (deterministic fixtures from governanceFixtures; not market data).
// Series are long enough for the MEASURED history requirement (360/360/360/120, docs/HISTORY_DEPTH.md).
export const bundleFor = (kind: "up" | "range"): Record<"4H" | "1H" | "15m" | "5m", ReturnType<typeof trendSeries>> => ({
  "4H": retime(kind === "range" ? range4HAtTop(400, 100, 110, 10) : trendSeries(400, TF["4H"], 100, 1), TF["4H"]),
  "1H": retime(trendSeries(400, TF["1H"], 100, 1), TF["1H"]),
  "15m": retime(trendSeries(400, TF["15m"], 100, 1), TF["15m"]),
  "5m": retime(kind === "range" ? fiveMinuteBearishFvgLong(130, 1, -0.3, -0.04) : trendSeries(200, TF["5m"], 100, 1), TF["5m"]),
});
export const loaderFrom = (kind: "up" | "range"): LoadRows => {
  const b = bundleFor(kind), byDb = new Map(PIPELINE_TIMEFRAMES.map((tf) => [DB_TIMEFRAME[tf], tf]));
  return async (_s, dbTf, limit) => {
    const tf = byDb.get(dbTf)!;
    const rows: StoredCandle[] = b[tf].map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, ingestedAt: c.time + TF_MS[tf] }));
    return rows.slice(-limit);
  };
};
