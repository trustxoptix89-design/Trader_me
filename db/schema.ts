import {
  mysqlTable, mysqlEnum, serial, varchar, text, timestamp, bigint, int,
  double, boolean, json, uniqueIndex, index,
} from "drizzle-orm/mysql-core";

export const users = mysqlTable("users", {
  id: serial("id").primaryKey(),
  unionId: varchar("unionId", { length: 255 }).notNull().unique(),
  name: varchar("name", { length: 255 }),
  email: varchar("email", { length: 320 }),
  avatar: text("avatar"),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull().$onUpdate(() => new Date()),
  lastSignInAt: timestamp("lastSignInAt").defaultNow().notNull(),
});

const userId = () => bigint("userId", { mode: "number", unsigned: true }).notNull();

export const riskSettings = mysqlTable("risk_settings", {
  id: serial("id").primaryKey(), userId: userId().notNull().unique(),
  equity: double("equity").notNull().default(10000),
  riskPerTradePct: double("riskPerTradePct").notNull().default(0.5),
  maxDailyLossPct: double("maxDailyLossPct").notNull().default(2),
  maxDrawdownPct: double("maxDrawdownPct").notNull().default(10),
  maxLeverage: double("maxLeverage").notNull().default(3),
  maxPortfolioRiskPct: double("maxPortfolioRiskPct").notNull().default(1.5),
  maxCorrelatedPositions: int("maxCorrelatedPositions").notNull().default(1),
  feePct: double("feePct").notNull().default(0.05),
  slippagePct: double("slippagePct").notNull().default(0.02),
  spreadPct: double("spreadPct").notNull().default(0.01),
  updatedAt: timestamp("updatedAt").defaultNow().notNull().$onUpdate(() => new Date()),
});

export const watchlist = mysqlTable("watchlist", {
  id: serial("id").primaryKey(), userId: userId().notNull(),
  symbol: varchar("symbol", { length: 24 }).notNull(),
  exchange: mysqlEnum("exchange", ["binance", "bybit"]).notNull().default("binance"),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({ uniqueAsset: uniqueIndex("watchlist_unique").on(t.userId, t.symbol, t.exchange) }));

export const analysisRuns = mysqlTable("analysis_runs", {
  id: varchar("id", { length: 64 }).primaryKey(), userId: bigint("userId", { mode: "number", unsigned: true }),
  symbol: varchar("symbol", { length: 24 }).notNull(),
  exchange: mysqlEnum("exchange", ["binance", "bybit"]).notNull(),
  status: mysqlEnum("status", ["approved", "no-entry", "invalidated", "expired"]).notNull(),
  result: json("result").notNull(), createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({ userTime: index("analysis_user_time").on(t.userId, t.createdAt) }));

export const backtests = mysqlTable("backtests", {
  id: varchar("id", { length: 64 }).primaryKey(), userId: userId().notNull(),
  symbol: varchar("symbol", { length: 24 }).notNull(),
  exchange: mysqlEnum("exchange", ["binance", "bybit"]).notNull(),
  interval: varchar("interval", { length: 8 }).notNull(),
  strategyVersion: varchar("strategyVersion", { length: 64 }).notNull(),
  result: json("result").notNull(), createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({ userTime: index("backtest_user_time").on(t.userId, t.createdAt) }));

export const paperTrades = mysqlTable("paper_trades", {
  id: serial("id").primaryKey(), userId: userId().notNull(),
  symbol: varchar("symbol", { length: 24 }).notNull(),
  exchange: mysqlEnum("exchange", ["binance", "bybit"]).notNull(),
  side: mysqlEnum("side", ["long", "short"]).notNull(),
  status: mysqlEnum("status", ["open", "closed"]).notNull().default("open"),
  quantity: double("quantity").notNull(), entry: double("entry").notNull(),
  exit: double("exit"), stop: double("stop").notNull(), target: double("target").notNull(),
  pnl: double("pnl"), fees: double("fees").notNull(),
  openedAt: timestamp("openedAt").defaultNow().notNull(), closedAt: timestamp("closedAt"),
}, (t) => ({ userStatus: index("paper_user_status").on(t.userId, t.status) }));

export const journalEntries = mysqlTable("journal_entries", {
  id: serial("id").primaryKey(), userId: userId().notNull(),
  symbol: varchar("symbol", { length: 24 }).notNull(),
  side: mysqlEnum("side", ["long", "short"]).notNull(),
  entry: double("entry").notNull(), exit: double("exit"),
  quantity: double("quantity").notNull(), pnl: double("pnl"),
  thesis: text("thesis").notNull(), mistakes: text("mistakes"),
  tradedAt: timestamp("tradedAt").notNull(), createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const alerts = mysqlTable("alerts", {
  id: serial("id").primaryKey(), userId: userId().notNull(),
  symbol: varchar("symbol", { length: 24 }).notNull(),
  exchange: mysqlEnum("exchange", ["binance", "bybit"]).notNull(),
  kind: mysqlEnum("kind", ["price-above", "price-below", "signal", "data-outage"]).notNull(),
  threshold: double("threshold"), enabled: boolean("enabled").notNull().default(true),
  lastTriggeredAt: timestamp("lastTriggeredAt"), lastValue: double("lastValue"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const notifications = mysqlTable("notifications", {
  id: serial("id").primaryKey(), userId: userId().notNull(),
  alertId: bigint("alertId", { mode: "number", unsigned: true }),
  kind: varchar("kind", { length: 32 }).notNull(), title: varchar("title", { length: 255 }).notNull(),
  body: text("body").notNull(), dedupeKey: varchar("dedupeKey", { length: 255 }).notNull().unique(),
  read: boolean("read").notNull().default(false), createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const pushSubscriptions = mysqlTable("push_subscriptions", {
  id: serial("id").primaryKey(), userId: userId().notNull(),
  endpoint: varchar("endpoint", { length: 1024 }).notNull(), keys: json("keys").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({ userEndpoint: uniqueIndex("push_user_endpoint").on(t.userId, t.endpoint) }));

export const systemEvents = mysqlTable("system_events", {
  id: serial("id").primaryKey(), level: mysqlEnum("level", ["info", "warn", "error"]).notNull(),
  event: varchar("event", { length: 128 }).notNull(), detail: text("detail"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const schedulerState = mysqlTable("scheduler_state", {
  id: varchar("id", { length: 32 }).primaryKey(), lastRunAt: timestamp("lastRunAt"),
  lastSuccessAt: timestamp("lastSuccessAt"), lastError: text("lastError"), runCount: int("runCount").notNull().default(0),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;
export type PaperTrade = typeof paperTrades.$inferSelect;
export type Alert = typeof alerts.$inferSelect;
export type JournalEntry = typeof journalEntries.$inferSelect;
