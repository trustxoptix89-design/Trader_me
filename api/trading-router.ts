import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { createRouter, authedQuery, publicQuery } from "./middleware";
import { alerts, analysisRuns, backtests, journalEntries, notifications, paperTrades, pushSubscriptions, riskSettings, schedulerState, systemEvents, watchlist } from "@db/schema";
import { analyzeMarket } from "./engines/analysis";
import { runBacktest, STRATEGY_VERSION } from "./engines/backtest";
import { fetchCandles, fetchFundingHistory, fetchSnapshotWithFallback, connectorHealth } from "./connectors/market";
import { fetchNews, macroAssessment } from "./connectors/news";
import { calculatePosition, assessRisk } from "./engines/risk";
import { DEFAULT_RISK, type AnalysisResult, type BacktestResult, type Exchange, type RiskSettings } from "@contracts/types";
import { TRPCError } from "@trpc/server";

const exchangeSchema = z.enum(["yahoo"]);
const intervalSchema = z.enum(["1m", "3m", "5m", "15m", "30m", "1h", "4h", "1d"]);
const symbolSchema = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{5,20}$/);
const riskSchema = z.object({
  equity: z.number().positive().max(100_000_000), riskPerTradePct: z.number().min(0.05).max(2),
  maxDailyLossPct: z.number().min(0.5).max(20), maxDrawdownPct: z.number().min(1).max(50),
  maxLeverage: z.number().min(1).max(10), maxPortfolioRiskPct: z.number().min(0.1).max(10),
  maxCorrelatedPositions: z.number().int().min(0).max(10), feePct: z.number().min(0).max(1),
  slippagePct: z.number().min(0).max(1), spreadPct: z.number().min(0).max(1),
});

export async function getRisk(userId: number): Promise<RiskSettings> {
  const db = getDb();
  const [row] = await db.select().from(riskSettings).where(eq(riskSettings.userId, userId)).limit(1);
  if (row) return { equity: row.equity, riskPerTradePct: row.riskPerTradePct, maxDailyLossPct: row.maxDailyLossPct, maxDrawdownPct: row.maxDrawdownPct, maxLeverage: row.maxLeverage, maxPortfolioRiskPct: row.maxPortfolioRiskPct, maxCorrelatedPositions: row.maxCorrelatedPositions, feePct: row.feePct, slippagePct: row.slippagePct, spreadPct: row.spreadPct };
  await db.insert(riskSettings).values({ userId });
  return { ...DEFAULT_RISK };
}

async function ensureWatchlist(userId: number) {
  const db = getDb();
  const rows = await db.select().from(watchlist).where(eq(watchlist.userId, userId));
  if (!rows.length) await db.insert(watchlist).values([{ userId, symbol: "BTCUSDT" }, { userId, symbol: "ETHUSDT" }, { userId, symbol: "SOLUSDT" }]).onConflictDoUpdate({ target: [watchlist.userId, watchlist.symbol, watchlist.exchange], set: { enabled: true } });
  return db.select().from(watchlist).where(eq(watchlist.userId, userId)).orderBy(desc(watchlist.createdAt));
}

export async function strategyContext(userId: number | undefined, symbol: string, exchange: Exchange) {
  if (!userId) return { available: false, approved: false, details: ["برای ارزیابی آمار استراتژی ابتدا وارد شوید و بک‌تست معتبر اجرا کنید"] };
  const rows = await getDb().select().from(backtests).where(and(eq(backtests.userId, userId), eq(backtests.symbol, symbol), eq(backtests.exchange, exchange))).orderBy(desc(backtests.createdAt)).limit(1);
  const result = rows[0]?.result as unknown as BacktestResult | undefined;
  if (!result) return { available: false, approved: false, details: ["بک‌تست ثبت‌شده برای این دارایی و صرافی وجود ندارد"] };
  const approved = result.outOfSample.trades >= 10 && result.outOfSample.netPnl > 0 && result.robustness !== "fragile" && result.robustness !== "unsupported" && result.data.fundingPoints > 0;
  return { available: true, approved, details: approved ? [`بک‌تست ${result.strategyVersion} با ${result.outOfSample.trades} معاملهٔ خارج از نمونه تأیید شد`] : [`بک‌تست برای صدور سیگنال کافی نیست؛ OOS=${result.outOfSample.trades} معامله، PnL=${result.outOfSample.netPnl.toFixed(2)}، پایداری=${result.robustness}، Funding=${result.data.fundingPoints}`] };
}

export async function userRiskContext(userId: number | undefined) {
  if (!userId) return { settings: { ...DEFAULT_RISK }, dailyPnl: 0, openRiskPct: 0, correlatedPositions: 0 };
  const db = getDb();
  const [settings, open] = await Promise.all([getRisk(userId), db.select().from(paperTrades).where(and(eq(paperTrades.userId, userId), eq(paperTrades.status, "open")))]);
  const closed = await db.select().from(paperTrades).where(and(eq(paperTrades.userId, userId), eq(paperTrades.status, "closed"))).orderBy(desc(paperTrades.closedAt)).limit(100);
  const day = new Date(); day.setHours(0, 0, 0, 0);
  const dailyPnl = closed.filter((t) => t.closedAt && t.closedAt >= day).reduce((a, t) => a + (t.pnl ?? 0), 0);
  return { settings, dailyPnl, openRiskPct: open.length * settings.riskPerTradePct, correlatedPositions: open.length };
}

export const tradingRouter = createRouter({
  analyze: publicQuery.input(z.object({ exchange: exchangeSchema, symbol: symbolSchema, interval: intervalSchema })).mutation(async ({ ctx, input }) => {
    const userId = ctx.user?.id;
    const [risk, macro] = await Promise.all([userRiskContext(userId), macroAssessment()]);
    const exchangeForStrategy = input.exchange;
    const strategy = await strategyContext(userId, input.symbol, exchangeForStrategy);
    const result = await analyzeMarket({ ...input, riskSettings: risk.settings, macro, strategy, dailyPnl: risk.dailyPnl, openRiskPct: risk.openRiskPct, correlatedPositions: risk.correlatedPositions });
    await getDb().insert(analysisRuns).values({ id: result.signal.id, userId, symbol: result.snapshot.symbol, exchange: result.snapshot.exchange, status: result.signal.status, result });
    return result;
  }),
  analysisHistory: authedQuery.query(async ({ ctx }) => {
    const rows = await getDb().select().from(analysisRuns).where(eq(analysisRuns.userId, ctx.user.id)).orderBy(desc(analysisRuns.createdAt)).limit(50);
    return rows.map((r) => ({ id: r.id, symbol: r.symbol, exchange: r.exchange, status: r.status, createdAt: r.createdAt, result: r.result as unknown as AnalysisResult }));
  }),
  backtest: authedQuery.input(z.object({
    exchange: exchangeSchema, symbol: symbolSchema, interval: intervalSchema, limit: z.number().int().min(300).max(1000).default(1000),
    fast: z.number().int().min(2).max(100).default(20), slow: z.number().int().min(3).max(200).default(50),
    atrStop: z.number().min(0.5).max(5).default(1.5), rewardRisk: z.number().min(1).max(10).default(2), maxHoldingBars: z.number().int().min(1).max(500).default(48),
  })).mutation(async ({ ctx, input }) => {
    const exchange: Exchange = input.exchange;
    const candles = await fetchCandles(exchange, input.symbol, input.interval, input.limit);
    const funding = await fetchFundingHistory();
    const result = runBacktest({ candles, funding, settings: await getRisk(ctx.user.id), params: input, symbol: input.symbol, exchange, interval: input.interval });
    await getDb().insert(backtests).values({ id: result.runId, userId: ctx.user.id, symbol: input.symbol, exchange, interval: input.interval, strategyVersion: STRATEGY_VERSION, result });
    return result;
  }),
  backtestList: authedQuery.query(async ({ ctx }) => {
    const rows = await getDb().select().from(backtests).where(eq(backtests.userId, ctx.user.id)).orderBy(desc(backtests.createdAt)).limit(30);
    return rows.map((r) => r.result as unknown as BacktestResult);
  }),
  riskGet: authedQuery.query(({ ctx }) => getRisk(ctx.user.id)),
  riskUpdate: authedQuery.input(riskSchema).mutation(async ({ ctx, input }) => {
    await getDb().insert(riskSettings).values({ userId: ctx.user.id, ...input }).onConflictDoUpdate({ target: riskSettings.userId, set: input });
    return getRisk(ctx.user.id);
  }),
  positionSize: publicQuery.input(z.object({ settings: riskSchema, entry: z.number().positive(), stop: z.number().positive() })).query(({ input }) => calculatePosition(input.settings, input.entry, input.stop)),
  watchlist: authedQuery.query(({ ctx }) => ensureWatchlist(ctx.user.id)),
  watchlistAdd: authedQuery.input(z.object({ symbol: symbolSchema, exchange: exchangeSchema })).mutation(async ({ ctx, input }) => {
    await getDb().insert(watchlist).values({ userId: ctx.user.id, ...input }).onConflictDoUpdate({ target: [watchlist.userId, watchlist.symbol, watchlist.exchange], set: { enabled: true } });
    return ensureWatchlist(ctx.user.id);
  }),
  watchlistRemove: authedQuery.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    await getDb().delete(watchlist).where(and(eq(watchlist.id, input.id), eq(watchlist.userId, ctx.user.id)));
    return ensureWatchlist(ctx.user.id);
  }),
  paperList: authedQuery.query(({ ctx }) => getDb().select().from(paperTrades).where(eq(paperTrades.userId, ctx.user.id)).orderBy(desc(paperTrades.openedAt)).limit(100)),
  paperOpen: authedQuery.input(z.object({ exchange: exchangeSchema, symbol: symbolSchema, side: z.enum(["long", "short"]) })).mutation(async ({ ctx, input }) => {
    const settings = await getRisk(ctx.user.id), snapshot = await fetchSnapshotWithFallback(input.exchange, input.symbol, "15m");
    const entry = snapshot.derivatives.markPrice ?? snapshot.candles.at(-1)!.close;
    const recent = snapshot.candles.slice(-30), atrProxy = recent.reduce((a, c) => a + c.high - c.low, 0) / recent.length;
    const stop = input.side === "long" ? entry - atrProxy * 1.5 : entry + atrProxy * 1.5;
    const target = input.side === "long" ? entry + atrProxy * 3 : entry - atrProxy * 3;
    const open = await getDb().select().from(paperTrades).where(and(eq(paperTrades.userId, ctx.user.id), eq(paperTrades.status, "open")));
    const risk = assessRisk(settings, input.side, entry, stop, target, { ...((await import("./engines/indicators")).computeMetrics(snapshot)) }, { openRiskPct: open.length * settings.riskPerTradePct, correlatedPositions: open.filter((t) => t.symbol === input.symbol).length, dataComplete: snapshot.isFresh });
    if (!risk.approved || !risk.positionSize) throw new TRPCError({ code: "BAD_REQUEST", message: risk.reasons.join("؛") });
    const fees = risk.positionSize * entry * settings.feePct / 100;
    await getDb().insert(paperTrades).values({ userId: ctx.user.id, symbol: input.symbol, exchange: snapshot.exchange, side: input.side, quantity: risk.positionSize, entry, stop, target, fees });
    return { ok: true, entry, stop, target, quantity: risk.positionSize };
  }),
  paperClose: authedQuery.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    const db = getDb(), [trade] = await db.select().from(paperTrades).where(and(eq(paperTrades.id, input.id), eq(paperTrades.userId, ctx.user.id), eq(paperTrades.status, "open"))).limit(1);
    if (!trade) throw new TRPCError({ code: "NOT_FOUND", message: "موقعیت باز یافت نشد" });
    const snapshot = await fetchSnapshotWithFallback(trade.exchange, trade.symbol, "1m");
    if (snapshot.exchange !== trade.exchange || !snapshot.isFresh) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "قیمت تازه از منبع داده در دسترس نیست؛ موقعیت بدون تغییر باز ماند" });
    const exit = snapshot.derivatives.markPrice ?? snapshot.candles.at(-1)!.close;
    const settings = await getRisk(ctx.user.id), exitFee = exit * trade.quantity * settings.feePct / 100;
    const sign = trade.side === "long" ? 1 : -1;
    const pnl = (exit - trade.entry) * trade.quantity * sign - trade.fees - exitFee;
    await db.update(paperTrades).set({ status: "closed", exit, pnl, fees: trade.fees + exitFee, closedAt: new Date() }).where(eq(paperTrades.id, trade.id));
    return { ok: true, exit, pnl };
  }),
  journalList: authedQuery.query(({ ctx }) => getDb().select().from(journalEntries).where(eq(journalEntries.userId, ctx.user.id)).orderBy(desc(journalEntries.tradedAt)).limit(100)),
  journalAdd: authedQuery.input(z.object({ symbol: symbolSchema, side: z.enum(["long", "short"]), entry: z.number().positive(), exit: z.number().positive().optional(), quantity: z.number().positive(), pnl: z.number().optional(), thesis: z.string().min(3).max(5000), mistakes: z.string().max(5000).optional(), tradedAt: z.date() })).mutation(async ({ ctx, input }) => {
    await getDb().insert(journalEntries).values({ userId: ctx.user.id, ...input }); return { ok: true };
  }),
  journalDelete: authedQuery.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    await getDb().delete(journalEntries).where(and(eq(journalEntries.id, input.id), eq(journalEntries.userId, ctx.user.id))); return { ok: true };
  }),
  alertList: authedQuery.query(({ ctx }) => getDb().select().from(alerts).where(eq(alerts.userId, ctx.user.id)).orderBy(desc(alerts.createdAt))),
  alertAdd: authedQuery.input(z.object({ symbol: symbolSchema, exchange: exchangeSchema, kind: z.enum(["price-above", "price-below", "signal", "data-outage"]), threshold: z.number().positive().optional() })).mutation(async ({ ctx, input }) => {
    if ((input.kind === "price-above" || input.kind === "price-below") && !input.threshold) throw new TRPCError({ code: "BAD_REQUEST", message: "برای هشدار قیمت، آستانه لازم است" });
    await getDb().insert(alerts).values({ userId: ctx.user.id, ...input }); return { ok: true };
  }),
  alertToggle: authedQuery.input(z.object({ id: z.number().int().positive(), enabled: z.boolean() })).mutation(async ({ ctx, input }) => {
    await getDb().update(alerts).set({ enabled: input.enabled }).where(and(eq(alerts.id, input.id), eq(alerts.userId, ctx.user.id))); return { ok: true };
  }),
  alertDelete: authedQuery.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    await getDb().delete(alerts).where(and(eq(alerts.id, input.id), eq(alerts.userId, ctx.user.id))); return { ok: true };
  }),
  notificationList: authedQuery.query(({ ctx }) => getDb().select().from(notifications).where(eq(notifications.userId, ctx.user.id)).orderBy(desc(notifications.createdAt)).limit(50)),
  notificationRead: authedQuery.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    await getDb().update(notifications).set({ read: true }).where(and(eq(notifications.id, input.id), eq(notifications.userId, ctx.user.id))); return { ok: true };
  }),
  pushSubscribe: authedQuery.input(z.object({ endpoint: z.string().url().max(1024), keys: z.object({ p256dh: z.string(), auth: z.string() }) })).mutation(async ({ ctx, input }) => {
    await getDb().insert(pushSubscriptions).values({ userId: ctx.user.id, endpoint: input.endpoint, keys: input.keys }).onConflictDoUpdate({ target: [pushSubscriptions.userId, pushSubscriptions.endpoint], set: { keys: input.keys } }); return { ok: true };
  }),
  publicConfig: publicQuery.query(() => ({ vapidPublicKey: process.env.VAPID_PUBLIC_KEY ?? null, pushConfigured: Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY), realTradingEnabled: false })),
  news: publicQuery.query(() => fetchNews()),
  macro: publicQuery.query(() => macroAssessment()),
  sourceHealth: publicQuery.query(async () => Promise.all([connectorHealth("yahoo")])),
  health: publicQuery.query(async () => {
    let database = false;
    try { await getDb().select().from(riskSettings).limit(1); database = true; } catch { database = false; }
    const [sources, scheduler, events] = await Promise.all([Promise.all([connectorHealth("yahoo")]), getDb().select().from(schedulerState).limit(1).catch(() => []), getDb().select().from(systemEvents).orderBy(desc(systemEvents.createdAt)).limit(10).catch(() => [])]);
    return { ok: database, database, sources, scheduler: scheduler[0] ?? null, events, serverTime: Date.now(), realTradingEnabled: false, schedulerMode: "in-process + protected external cron endpoint" };
  }),
});
