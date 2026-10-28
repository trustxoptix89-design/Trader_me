import {
  pgSchema, serial, varchar, text, timestamp, bigint, integer,
  doublePrecision, boolean, jsonb, uniqueIndex, index,
} from "drizzle-orm/pg-core";

/** Everything lives in its own Postgres schema so it can share a Supabase project without touching `public`. */
export const sarmaye = pgSchema("sarmaye");

const exchangeEnum = sarmaye.enum("exchange", ["yahoo"]);
const sideEnum = sarmaye.enum("side", ["long", "short"]);
const roleEnum = sarmaye.enum("role", ["user", "admin"]);
const analysisStatusEnum = sarmaye.enum("analysis_status", ["approved", "no-entry", "invalidated", "expired"]);
const paperStatusEnum = sarmaye.enum("paper_status", ["open", "closed"]);
const alertKindEnum = sarmaye.enum("alert_kind", ["price-above", "price-below", "signal", "data-outage"]);
const eventLevelEnum = sarmaye.enum("event_level", ["info", "warn", "error"]);

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const users = sarmaye.table("users", {
  id: serial("id").primaryKey(),
  unionId: varchar("unionId", { length: 255 }).notNull().unique(),
  name: varchar("name", { length: 255 }),
  email: varchar("email", { length: 320 }),
  avatar: text("avatar"),
  role: roleEnum("role").default("user").notNull(),
  createdAt: ts("createdAt").defaultNow().notNull(),
  updatedAt: ts("updatedAt").defaultNow().notNull().$onUpdate(() => new Date()),
  lastSignInAt: ts("lastSignInAt").defaultNow().notNull(),
});

const userId = () => bigint("userId", { mode: "number" }).notNull();

export const riskSettings = sarmaye.table("risk_settings", {
  id: serial("id").primaryKey(), userId: userId().notNull().unique(),
  equity: doublePrecision("equity").notNull().default(10000),
  riskPerTradePct: doublePrecision("riskPerTradePct").notNull().default(0.5),
  maxDailyLossPct: doublePrecision("maxDailyLossPct").notNull().default(2),
  maxDrawdownPct: doublePrecision("maxDrawdownPct").notNull().default(10),
  maxLeverage: doublePrecision("maxLeverage").notNull().default(3),
  maxPortfolioRiskPct: doublePrecision("maxPortfolioRiskPct").notNull().default(1.5),
  maxCorrelatedPositions: integer("maxCorrelatedPositions").notNull().default(1),
  feePct: doublePrecision("feePct").notNull().default(0.05),
  slippagePct: doublePrecision("slippagePct").notNull().default(0.02),
  spreadPct: doublePrecision("spreadPct").notNull().default(0.01),
  updatedAt: ts("updatedAt").defaultNow().notNull().$onUpdate(() => new Date()),
});

export const watchlist = sarmaye.table("watchlist", {
  id: serial("id").primaryKey(), userId: userId().notNull(),
  symbol: varchar("symbol", { length: 24 }).notNull(),
  exchange: exchangeEnum("exchange").notNull().default("yahoo"),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: ts("createdAt").defaultNow().notNull(),
}, (t) => ({ uniqueAsset: uniqueIndex("watchlist_unique").on(t.userId, t.symbol, t.exchange) }));

export const analysisRuns = sarmaye.table("analysis_runs", {
  id: varchar("id", { length: 64 }).primaryKey(), userId: bigint("userId", { mode: "number" }),
  symbol: varchar("symbol", { length: 24 }).notNull(),
  exchange: exchangeEnum("exchange").notNull(),
  status: analysisStatusEnum("status").notNull(),
  result: jsonb("result").notNull(), createdAt: ts("createdAt").defaultNow().notNull(),
}, (t) => ({ userTime: index("analysis_user_time").on(t.userId, t.createdAt) }));

export const backtests = sarmaye.table("backtests", {
  id: varchar("id", { length: 64 }).primaryKey(), userId: userId().notNull(),
  symbol: varchar("symbol", { length: 24 }).notNull(),
  exchange: exchangeEnum("exchange").notNull(),
  interval: varchar("interval", { length: 8 }).notNull(),
  strategyVersion: varchar("strategyVersion", { length: 64 }).notNull(),
  result: jsonb("result").notNull(), createdAt: ts("createdAt").defaultNow().notNull(),
}, (t) => ({ userTime: index("backtest_user_time").on(t.userId, t.createdAt) }));

export const paperTrades = sarmaye.table("paper_trades", {
  id: serial("id").primaryKey(), userId: userId().notNull(),
  symbol: varchar("symbol", { length: 24 }).notNull(),
  exchange: exchangeEnum("exchange").notNull(),
  side: sideEnum("side").notNull(),
  status: paperStatusEnum("status").notNull().default("open"),
  quantity: doublePrecision("quantity").notNull(), entry: doublePrecision("entry").notNull(),
  exit: doublePrecision("exit"), stop: doublePrecision("stop").notNull(), target: doublePrecision("target").notNull(),
  pnl: doublePrecision("pnl"), fees: doublePrecision("fees").notNull(),
  openedAt: ts("openedAt").defaultNow().notNull(), closedAt: ts("closedAt"),
}, (t) => ({ userStatus: index("paper_user_status").on(t.userId, t.status) }));

export const journalEntries = sarmaye.table("journal_entries", {
  id: serial("id").primaryKey(), userId: userId().notNull(),
  symbol: varchar("symbol", { length: 24 }).notNull(),
  side: sideEnum("side").notNull(),
  entry: doublePrecision("entry").notNull(), exit: doublePrecision("exit"),
  quantity: doublePrecision("quantity").notNull(), pnl: doublePrecision("pnl"),
  thesis: text("thesis").notNull(), mistakes: text("mistakes"),
  tradedAt: ts("tradedAt").notNull(), createdAt: ts("createdAt").defaultNow().notNull(),
});

export const alerts = sarmaye.table("alerts", {
  id: serial("id").primaryKey(), userId: userId().notNull(),
  symbol: varchar("symbol", { length: 24 }).notNull(),
  exchange: exchangeEnum("exchange").notNull(),
  kind: alertKindEnum("kind").notNull(),
  threshold: doublePrecision("threshold"), enabled: boolean("enabled").notNull().default(true),
  lastTriggeredAt: ts("lastTriggeredAt"), lastValue: doublePrecision("lastValue"),
  createdAt: ts("createdAt").defaultNow().notNull(),
});

export const notifications = sarmaye.table("notifications", {
  id: serial("id").primaryKey(), userId: userId().notNull(),
  alertId: bigint("alertId", { mode: "number" }),
  kind: varchar("kind", { length: 32 }).notNull(), title: varchar("title", { length: 255 }).notNull(),
  body: text("body").notNull(), dedupeKey: varchar("dedupeKey", { length: 255 }).notNull().unique(),
  read: boolean("read").notNull().default(false), createdAt: ts("createdAt").defaultNow().notNull(),
});

export const pushSubscriptions = sarmaye.table("push_subscriptions", {
  id: serial("id").primaryKey(), userId: userId().notNull(),
  endpoint: varchar("endpoint", { length: 1024 }).notNull(), keys: jsonb("keys").notNull(),
  createdAt: ts("createdAt").defaultNow().notNull(),
}, (t) => ({ userEndpoint: uniqueIndex("push_user_endpoint").on(t.userId, t.endpoint) }));

export const systemEvents = sarmaye.table("system_events", {
  id: serial("id").primaryKey(), level: eventLevelEnum("level").notNull(),
  event: varchar("event", { length: 128 }).notNull(), detail: text("detail"),
  createdAt: ts("createdAt").defaultNow().notNull(),
});

export const schedulerState = sarmaye.table("scheduler_state", {
  id: varchar("id", { length: 32 }).primaryKey(), lastRunAt: ts("lastRunAt"),
  lastSuccessAt: ts("lastSuccessAt"), lastError: text("lastError"), runCount: integer("runCount").notNull().default(0),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;
export type PaperTrade = typeof paperTrades.$inferSelect;
export type Alert = typeof alerts.$inferSelect;
export type JournalEntry = typeof journalEntries.$inferSelect;
