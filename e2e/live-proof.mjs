// Live end-to-end proof: real browser -> real server -> real Yahoo/CoinGecko data -> chart on screen.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const base = process.env.BASE_URL ?? "http://localhost:3000";
const out = process.env.OUT_DIR ?? "e2e-out";
mkdirSync(out, { recursive: true });
const report = { startedAt: new Date().toISOString(), runs: [] };

const browser = await chromium.launch();
for (const [symbol, label] of [["BTCUSDT", "btc"], ["ETHUSDT", "eth"]]) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: "fa-IR", timezoneId: "Asia/Tehran" });
  const page = await ctx.newPage();
  const run = { symbol, consoleErrors: [], analyze: null, ui: {} };
  page.on("pageerror", (e) => run.consoleErrors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") run.consoleErrors.push(m.text().slice(0, 300)); });
  page.on("response", async (r) => {
    if (!r.url().includes("trading.analyze")) return;
    try {
      const body = await r.json();
      const data = (Array.isArray(body) ? body[0] : body)?.result?.data;
      const res = data?.json ?? data;
      const snap = res?.snapshot;
      run.analyze = { status: r.status(), error: (Array.isArray(body) ? body[0] : body)?.error?.json?.message ?? null };
      if (snap) {
        const last = snap.candles.at(-1);
        run.analyze = { ...run.analyze, source: snap.exchange, marketType: snap.marketType, candles: snap.candles.length, firstTime: new Date(snap.candles[0].time).toISOString(), lastTime: new Date(last.time).toISOString(), lastClose: last.close, isFresh: snap.isFresh, dataQuality: snap.dataQuality, crossCheck: snap.crossCheck, warnings: snap.warnings, signalStatus: res.signal.status, verdicts: res.reviews.map((x) => x.verdict).join(",") };
      }
    } catch (e) { run.analyze = { parseError: String(e) }; }
  });
  await page.goto(base, { waitUntil: "networkidle" });
  await page.locator("select").first().selectOption(symbol).catch(() => {});
  await page.locator("form.market-controls button[type=submit], form.market-controls button").last().click();
  try {
    await page.waitForSelector(".dashboard-grid", { timeout: 90_000 });
    await page.waitForSelector(".chart-wrap canvas, .tv-chart", { timeout: 30_000 });
    await page.waitForTimeout(1500);
    run.ui.quote = (await page.locator(".quote-row").first().innerText()).replace(/\s+/g, " ");
    run.ui.sourceLine = (await page.locator(".source-line").first().innerText()).replace(/\s+/g, " ");
    run.ui.signal = (await page.locator(".signal-panel").innerText()).replace(/\s+/g, " ").slice(0, 400);
    run.ui.chartCanvasCount = await page.locator(".chart-wrap canvas").count();
  } catch (e) { run.ui.error = String(e).slice(0, 300); }
  await page.screenshot({ path: `${out}/${label}-mobile.png`, fullPage: true });
  await ctx.close();
  report.runs.push(run);
}
await browser.close();
report.finishedAt = new Date().toISOString();
writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (report.runs.some((r) => r.ui.error || !r.analyze?.candles)) process.exitCode = 1;
