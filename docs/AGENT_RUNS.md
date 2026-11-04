# agent_runs — ثبت اجرای عامل‌ها (V6 §4-C، §6)

وضعیت: **IMPLEMENTED** (کد + migration `0004_agent_runs.sql` + تست). به Scheduler، Orchestrator و `runSignalPipeline` **وصل نشده** است (تصمیم صریح مالک پروژه برای این مرحله).

## طراحی
- هر عامل برای هر سیگنال دقیقاً یک ردیف دارد: کلید یکتا `signal_id:agent_id` (ستون `idempotency_key` و ایندکس یکتای `(signal_id, agent_id)`).
- ردیف‌ها تغییرناپذیرند: trigger مثل `audit_log` جلوی UPDATE/DELETE/TRUNCATE را می‌گیرد. هر ردیف `row_hash` (SHA-256 از محتوای کانونی) دارد تا اگر superuser تریگر را غیرفعال کرد، تغییر قابل تشخیص باشد (`verifyAgentRuns`). این «تشخیص» است، نه «جلوگیری» (همان محدودیت `audit_log`).
- `input_hash` = SHA-256 از اعداد دقیق (time, OHLCV) همهٔ کندل‌های تایم‌فریم‌هایی که عامل می‌خواند. خود کندل‌ها کپی نمی‌شوند؛ `input_refs_json` فقط مرجع می‌دهد (تعداد، اولین و آخرین زمان) تا اجرا از جدول `candles` بازسازی و مقایسه شود. تایم‌فریم هر عامل در `AGENT_TIMEFRAMES` اعلام شده و تست آن را با `agents/*.yaml` مقایسه می‌کند.
- `findings_json.evidenceRefs` مرجع‌های قابل بازبینی می‌دهد: `agent:<id>@<version>` و `candles:<tf>:<first>..<last>:n=<count>`؛ از ورودی مشتق می‌شود، ساخته نمی‌شود.
- رأی: `findings_json.verdict/weight/reason`، `confidence` (۰ تا ۱)، `confidence_meaning = UNCALIBRATED_HEURISTIC_SCORE` (احتمال موفقیت نیست). Abstain: `abstained=true`، `validation_outcome=ABSTAIN`، دلیل در `missing_info` (اجباری با CHECK). خطای عامل: `validation_outcome=ERROR` + `error`.
- تکرار: همان محتوا ⇒ `append` مقدار `null` برمی‌گرداند و ردیف جدید نمی‌سازد. همان کلید با محتوای متفاوت ⇒ `AgentRunConflictError`، بدون بازنویسی.

## انحراف از ستون‌های V6 §6 (همه ناشی از وضعیت فعلی اسکیما)
| V6 | پیاده‌سازی | دلیل |
|---|---|---|
| `signal_id FK → signals` | `signal_id text`، بدون FK | جدول `signals` هنوز وجود ندارد؛ مقدار = `signalId` خط لوله = `audit_log.correlation_id` |
| `group` | `agent_group` | GROUP کلمهٔ رزروشدهٔ SQL است |
| `timestamp` | `run_at` (bigint ms) | همان نام‌گذاری `audit_log.ts` |
| — | `idempotency_key`, `row_hash`, `recorded_at` | exactly-once و تشخیص دست‌کاری |
| `agent_version` | `"unspecified"` اگر ندهند | نسخه از `agents/*.yaml` می‌آید؛ هرگز حدس زده نمی‌شود |

## سطوح تست (جدا از هم)
| سطح | فایل | محیط |
|---|---|---|
| داده واقعی (۹۹۹ کندل BTCUSDT 1h از Binance Vision، فایل ثابت) + حافظه | `agentRuns.test.ts` | همیشه |
| fake executor (نه دیتابیس واقعی): خطای اتصال، خطای غیر-unique | `agentRuns.test.ts` | همیشه |
| PostgreSQL واقعی | `agentRuns.postgres.test.ts` | فقط با `DB_PROBE=true` (CI: Postgres 17) |
| PostgreSQL 16.15 محلی با فرایند psql (هر دستور یک اتصال واقعی جدا) | اسکریپت موقت خارج از مخزن | یک‌بار، دستی |
