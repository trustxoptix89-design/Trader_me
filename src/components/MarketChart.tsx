import type { Candle } from "@contracts/types";
import { dateTime, price } from "@/lib/format";

export function MarketChart({ candles }: { candles: Candle[] }) {
  const data = candles.slice(-90);
  if (!data.length) return null;
  const W = 900, H = 360, top = 20, bottom = 292, volumeTop = 310;
  const low = Math.min(...data.map((c) => c.low)), high = Math.max(...data.map((c) => c.high));
  const range = high - low || 1, maxVolume = Math.max(...data.map((c) => c.volume), 1);
  const x = (i: number) => 44 + i * ((W - 60) / Math.max(1, data.length - 1));
  const y = (v: number) => top + (high - v) / range * (bottom - top);
  const bodyWidth = Math.max(2, (W - 60) / data.length * 0.55);
  return <div className="chart-wrap" dir="ltr">
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`نمودار ${data.length} کندل واقعی از ${dateTime(data[0].time)} تا ${dateTime(data.at(-1)!.time)}`}>
      {[0, .25, .5, .75, 1].map((v) => <g key={v}><line x1="42" x2={W - 10} y1={top + v * (bottom - top)} y2={top + v * (bottom - top)} className="grid-line" /><text x="4" y={top + v * (bottom - top) + 4} className="axis-text">{price(high - v * range)}</text></g>)}
      {data.map((c, i) => {
        const up = c.close >= c.open, color = up ? "#34d399" : "#f87171";
        return <g key={c.time} opacity={i < data.length - 1 ? .9 : 1}>
          <line x1={x(i)} x2={x(i)} y1={y(c.high)} y2={y(c.low)} stroke={color} strokeWidth="1" />
          <rect x={x(i) - bodyWidth / 2} y={Math.min(y(c.open), y(c.close))} width={bodyWidth} height={Math.max(1.5, Math.abs(y(c.open) - y(c.close)))} fill={color} />
          <rect x={x(i) - bodyWidth / 2} y={volumeTop + (1 - c.volume / maxVolume) * 32} width={bodyWidth} height={c.volume / maxVolume * 32} fill={color} opacity=".35" />
        </g>;
      })}
      <text x="44" y="355" className="axis-text">{dateTime(data[0].time)}</text>
      <text x={W - 150} y="355" className="axis-text">{dateTime(data.at(-1)!.time)}</text>
    </svg>
  </div>;
}

export function EquityChart({ points }: { points: { time: number; equity: number; sample: "train" | "test" }[] }) {
  if (points.length < 2) return <div className="mini-empty">منحنی سرمایه پس از ثبت معامله ساخته می‌شود.</div>;
  const W = 800, H = 240, min = Math.min(...points.map((p) => p.equity)), max = Math.max(...points.map((p) => p.equity)), range = max - min || 1;
  const coords = points.map((p, i) => `${20 + i * 760 / (points.length - 1)},${20 + (max - p.equity) / range * 180}`).join(" ");
  const split = points.findIndex((p) => p.sample === "test");
  return <svg className="equity-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="منحنی سرمایهٔ بک‌تست">
    <line x1="20" x2="780" y1="200" y2="200" className="grid-line" />
    {split > 0 && <line x1={20 + split * 760 / (points.length - 1)} x2={20 + split * 760 / (points.length - 1)} y1="12" y2="205" className="split-line" />}
    <polyline points={coords} fill="none" stroke="#22d3ee" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    <text x="20" y="228" className="axis-text">{price(min)}</text><text x="710" y="228" className="axis-text">{price(max)}</text>
  </svg>;
}
