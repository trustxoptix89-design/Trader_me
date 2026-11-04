# ماتریس تطبیق الزامات سند V6 با کد (ممیزی روی `a0d8f46`، شاخه `phase-e-integration`)

برچسب‌ها: IMPLEMENTED / TESTED / VERIFIED / IN PROGRESS / NOT IMPLEMENTED / BLOCKED.
TESTED = تست خودکار سبز در CI. VERIFIED = شاهد اجرای واقعی در محیط هدف (فقط جایی که واقعاً وجود دارد).
مرجع تصمیم: V6. تناقض‌ها در بخش آخر؛ هیچ قانون جدیدی ساخته نشده است.

## فاز A — داده
| الزام V6 | وضعیت | شاهد / شکاف |
|---|---|---|
| زنجیرهٔ منبع CoinGecko→CryptoCompare→Binance public→Yahoo، BLOCKED_SOURCE_DATA | TESTED | `api/ingest/ingest.ts runCascade`, `ingest.test.ts`؛ اجرای زندهٔ قبلی فقط در CI (`e2e-live.yml`) |
| تازگی/stale، dedupe، ثبت gap | TESTED | `computeFreshness`, `sanitizeCandles`, `findGaps` |
| جدول candles در DB واقعی | TESTED | migration 0002 + `ingest.integration.test.ts` (PG در CI) |
| داده 5m/15m/1h/4H مستقل از حساب صرافی | IN PROGRESS | CoinGecko فقط 30m/1h/4h؛ 5m/15m به Binance public/CryptoCompare/Yahoo وابسته است؛ اجرای زنده در شبکهٔ فعلی ممکن نیست (فقط CI) |
| rate limit 60 req/min | TESTED | `createRateLimiter` در `/api/candles` (روی `/api/health` اعمال نشده) |

## فاز B — اندیکاتورها
| الزام | وضعیت | شاهد |
|---|---|---|
| ۸ اندیکاتور با امضای مشترک `IndicatorResult` در فایل‌های جدا (`indicators/{rsi,macd,...}.ts`) | IN PROGRESS | محاسبات هست (`contracts/indicators.ts`, `api/engines/indicators.ts`, `deltaforce.*`) اما ساختار فایل/امضای V6 رعایت نشده |
| جدول طلایی ۳ نقطه‌ای | TESTED | `golden.test.ts` |
| BOS/CHoCH fractal N=5، S/R pivot k=3، sweep | IN PROGRESS | سه تابع ساختاری در کد هست؛ تطبیق خط‌به‌خط پارامترها با V6 بررسی نشده |
| ADX/FVG/OB/POC-VAH-VAL/RVOL/StochRSI (پیوست ۱) | NOT IMPLEMENTED (ADX قدیمی منحرف از TA-Lib) | — |

## فاز C — عوامل
| الزام | وضعیت | شاهد |
|---|---|---|
| قالب YAML برای هر عامل (`agents/*.yaml`) + اعتبارسنج قالب | TESTED | `api/orchestrator/agentSpec.ts`, `api/tests/agents.test.ts` |
| ≥۱۰ عامل واقعی با قالب YAML | NOT IMPLEMENTED: ۷ عامل واقعی (A01, B09, B10, B11, B12, B15 + DELTA_FORCE) از حداقل ۱۰ | سه عامل دیگر لازم است؛ V6 نام/قاعدهٔ اسلات‌ها را نداده (جز قواعد ضمیمهٔ ۲) |
| ۳۳ اسلات A01..E33 | IN PROGRESS: ۶ واقعی، ۲۷ stub صریح با `status: NOT_IMPLEMENTED` (در رأی‌گیری و KPI شرکت نمی‌کنند) | تست «هر اسلات دقیقاً یک بار» + «stub هرگز رأی نمی‌دهد» |
| تست داده واقعی (خروجی معتبر) و تست abstain برای هر عامل | TESTED (روی ۹۹۹ کندل BTCUSDT 1h واقعی fixture) | `agents.test.ts` |
| اجرای Orchestrator با ≤۳ عامل و ثبت `agent_runs` در DB | NOT IMPLEMENTED (جدول `agent_runs` وجود ندارد) | — |
| README: کدام deterministic/ai_call/stub | IN PROGRESS | فقط در YAMLها |

انحراف‌های ثبت‌شده: (۱) DELTA_FORCE در شماره‌گذاری V6 اسلات ندارد (بدون ابداع، خارج از ۳۳ نگه داشته شد). (۲) B15=Stochastic RSI از قاعدهٔ صریح ضمیمهٔ ۲ بخش ۶ ساخته شد؛ **انتساب این قاعده به اسلات B15 انتخاب اداری من است و نیاز به تأیید شما دارد.** (۳) افزودن عامل ششم، تعداد رأی‌ها را از ۶ به ۷ برد؛ سناریوهای E2E دوباره سبز شدند.

## فاز D — اتاق‌ها و حاکمیت
| الزام | وضعیت | شاهد |
|---|---|---|
| ماشین حالت + guard (کد: ۹ نام state؛ سند: عنوان «۸ State» — ابهام باز، بخش «ابهام ۸-در-برابر-۹» پایین) | TESTED | `machine.ts`, `hardening.test.ts` (233 تست CI) |
| POST_MORTEM پس از اجرا | NOT IMPLEMENTED | — |
| Data/Error/Chart Quality/Risk/Approval | TESTED (Error Detection: IN PROGRESS — قواعد MACD/RSI و BOS-vs-EMA200 نیست) | `rooms.ts`, `chartQuality.ts`, `approval.ts` |
| Independent Verifier با VETO مطلق | TESTED | `verifier.ts`، تست ایمپورت مستقل |
| Delta Force وزن ۳ در ULTRA_TREND، Range Mode | TESTED | `governance.test.ts` |
| Board + Supervisory Board (نمونه‌گیری هر ۱۰ سیگنال، PAUSED_PIPELINE) | NOT IMPLEMENTED | — |
| Post-Mortem Loop (agent_weights هر ۲۰ نتیجه) | NOT IMPLEMENTED | — |
| `/admin/org-health` | NOT IMPLEMENTED | — |
| Audit append-only + hash chain | TESTED (PG واقعی در CI) | `audit.postgres.ts`, `AUDIT_LOG.md`؛ محدودیت: owner/superuser می‌تواند تریگر را غیرفعال کند (تشخیص، نه جلوگیری) |
| اتصال PostgresAuditStore به runtime | IMPLEMENTED در این شاخه (`orchestrator/runtime.ts`)؛ **Scheduler هنوز `runSignalPipeline` را اصلاً صدا نمی‌زند** (از `analyzeMarket` قدیمی استفاده می‌کند) | بلوکر بعدی |
| نقش محدود DB (SELECT/INSERT) در استقرار | IN PROGRESS | فقط در تست نشان داده شده؛ اعمال در production نیازمند تأیید شما |
| schema ردیف `audit_log` مطابق §6 | IN PROGRESS | ستون‌ها متفاوت‌اند (تناقض T-1 زیر) |

## فاز E–H
| الزام | وضعیت | شاهد |
|---|---|---|
| TradingView + Lightweight Charts + overlay سیگنال | IN PROGRESS | `TradingViewChart.tsx`, `MarketChart.tsx`؛ overlay سیگنال/اسکرین‌شات ندارد |
| بک‌تست: walk-forward، Wilson، کارمزد/slippage/funding، اثرانگشت | TESTED (IN PROGRESS نسبت به V6: وابسته به استراتژی ema-rsi-atr قدیمی، نه خروجی خط لولهٔ جدید) | `backtest.ts`, `engines.test.ts`, `backtestFingerprint` |
| `/health` JSON با فیلدهای V6 | IMPLEMENTED (این شاخه: `routes/health.ts`)؛ تست CI | TESTED پس از سبز شدن CI |
| هشدار آزمایشی واقعی Telegram/log | IN PROGRESS | فقط Web Push+جدول notifications؛ Telegram نیست؛ تست هشدار واقعی انجام نشده |
| استقرار عمومی (Render/Cloudflare/Netlify) | NOT STARTED/NOT VERIFIED | نیاز به تأیید شما (حساب/هزینه) |
| README تحویل | IN PROGRESS | جدول وضعیت هست؛ راهنمای تحویل کامل نیست |

## چک‌لیست پذیرش §14 (خلاصه)
فرانت‌اند عمومی: NOT IMPLEMENTED(استقرار) · داده واقعی در DB: TESTED (CI)، VERIFIED نشده · اندیکاتورها: IN PROGRESS · BOS/S-R: IN PROGRESS · ≥۱۰ عامل YAML: IN PROGRESS (۶ شماره‌دار + Delta Force؛ هدف ۱۰ هنوز برآورده نیست) · ۳ اتاق: TESTED · Chart Quality+Approval: TESTED · VETO: TESTED · pipeline اسپات+فیوچرز: IN PROGRESS (در تست‌ها؛ در runtime وصل نیست) · audit ۸ مرحله: TESTED (PG) · post-mortem: NOT IMPLEMENTED · org-health: NOT IMPLEMENTED · overlay: NOT IMPLEMENTED · بک‌تست بازتولیدپذیر: TESTED · health 200: IMPLEMENTED→TESTED پس از CI · هشدار آزمایشی: NOT VERIFIED · README: IN PROGRESS · بلوکرهای مستند: این سند.

## تناقض‌ها (نیازمند تأیید شما، بدون ابداع قانون)
- T-1: ستون‌های `audit_log` در §6 (signal_id/state/room/verdict/reason/input_hash/output_hash/timestamp/idempotency_key) با طرح فعلی (زنجیرهٔ hash + seq) فرق دارد. پیشنهاد: نگاشت view سازگار با §6.
- T-2 (D-3): Delta CONFLICT → توقف در RECONCILED در پیاده‌سازی، با V2 هم‌خوان نیست.
- T-3: شروع تنظیم آستانه‌ها: همهٔ پارامترهای فعلی REFERENCE/PROPOSED‌اند و EMPIRICAL ندارند.
- T-4: **حل‌شده با تصمیم معماری D-4** (بخش بعد).

## تصمیم معماری D-4 (شما، ۲ نوامبر ۲۰۲۶): تولید Setup
متن تصمیم: Entry/SL/TP را یک موتور قطعی، مستقل از LLM و بر پایهٔ تحلیل تکنیکال معتبر و داده تولید می‌کند. اتاق Risk فقط اعتبارسنجی می‌کند (R:R، محدودیت‌ها) و مرجع تولید نقاط نیست. Independent Verifier حق رد/وتوی Setup را دارد. Elite Council فقط بازبین نهایی است و جای محاسبهٔ قطعی را نمی‌گیرد. دادهٔ ناکافی → ABSTAIN/NO_TRADE، نه عدد تخمینی.
- **مرز با V6:** V6 §0.4 (قطعی بر LLM مقدم است) و §4-D (Risk Room ورودی entry/invalidation/targets می‌گیرد؛ Verifier آنها را از داده خام بازمحاسبه و VETO می‌کند) را تقویت می‌کند و با هیچ بند صریحی تناقض ندارد. V6 فرمول تولید Entry/SL/TP را تعریف نکرده؛ این فرمول **تصمیم D-4 نیست و تأیید جدا می‌خواهد**.
- **پیاده‌سازی:** `api/orchestrator/setupEngine.ts`، قاعدهٔ R1: entry=close آخرین کندل؛ invalidation=آخرین swing تأییدشدهٔ سمت محافظ (fractal k=3، REFERENCE از V6 فاز B)؛ targets=swingهای تأییدشدهٔ مقابل به ترتیب نزدیکی؛ هیچ عدد/آستانهٔ جدیدی ندارد (فقط پارامترهای config موجود). R:R/ATR/کارمزد را قضاوت نمی‌کند. بدون ساختار → NO_TRADE؛ داده نامعتبر → ABSTAIN. خروجی با `validateSetupResult` و trace (hash ورودی، زمان swingها، fingerprint config) قابل بررسی است.
- **وضعیت:** TESTED (تست مستقل `setupEngine.test.ts`، شامل داده واقعی و تست «موتور هیچ اتاق/Verifier/LLM ایمپورت نمی‌کند»). قاعدهٔ R1 به‌عنوان قاعدهٔ استراتژی **در انتظار تأیید شما** است و به Scheduler وصل نشده.


## یادداشت نام‌گذاری
«D-4» در `docs/STATE_MACHINE.md` (محدودهٔ Verifier) با «D-4» همین ماتریس (تصمیم تولید Setup، ۲ نوامبر ۲۰۲۶) دو تصمیم متفاوت‌اند. برچسب «PARTIAL» قدیمی در این سند با برچسب مجاز «IN PROGRESS» جایگزین شد.

## ابهام ۸-در-برابر-۹ state (باز؛ منتظر تصمیم مالک)
متن دقیق V6 (فاز D): عنوان «۸ State:» و بلافاصله ۹ نام فهرست شده: DETECTED، DATA_VALIDATED، INDICATORS_READY، AGENTS_RUN، RECONCILED، RISK_CHECKED، GATED، RECORDED، NOTIFIED (و POST_MORTEM جدا، پس از outcome). همان سند در معماری «Orchestrator / CEO (8-state machine)»، در تعریف موفقیت «۸ state … log_audit» و در تست یکپارچگی «مسیر ۸ state» می‌نویسد. فقط ۸ **گذار** (فلش) بین ۹ نام وجود دارد.
- کد: ۹ state (۸ گذار) + POST_MORTEM پیاده‌نشده.
- هیچ شاهد قطعی در متن نیست که «۸» یعنی «۸ گذار». این تفسیر پذیرفته **نشد**؛ کد و تست‌ها تغییر نکردند. گزینه‌ها برای تصمیم شما: (الف) ۹ state، ۸ گذار — اصلاح عنوان در مستند؛ (ب) یک state حذف/ادغام شود (مثلاً NOTIFIED یا DETECTED) که تغییر کد است. وضعیت: BLOCKED تا تصمیم.

## جدول یکپارچهٔ عامل‌ها (برچسب‌های مجاز §۱۲)
| عامل | نوع | وضعیت | یادداشت |
|---|---|---|---|
| A01 Market Structure | deterministic | TESTED (CI) | agent_runs: IMPLEMENTED/TESTED |
| B09, B10, B11, B12 (اندیکاتورها) | deterministic | TESTED (CI) | |
| B15 StochRSI | deterministic | TESTED (CI) | تخصیص اسلات B15 هنوز تأیید نشده |
| DELTA_FORCE | deterministic | TESTED (CI) | خارج از ۳۳ عامل؛ نیازمند تأیید اسلات |
| ۲۷ عامل دیگر (A02–A08، B13–B14، B16، C17–C23، D24–D28، E29–E33) | stub (`status: NOT_IMPLEMENTED`) | NOT STARTED | در KPI شرکت نمی‌کنند |
مجموع: ۶ شماره‌دار + Delta = ۷ رأی‌دهنده؛ ۲۷ stub؛ هدف V6 «حداقل ۱۰ عامل واقعی» = IN PROGRESS.

## وضعیت قابلیت‌ها (جدید/تغییرکرده)
| قابلیت | وضعیت | شاهد / محدودیت |
|---|---|---|
| جدول `agent_runs` + ثبت | IMPLEMENTED (TESTED محلی با PG 16.15؛ TESTED در CI پس از اجرای PG17) | `docs/AGENT_RUNS.md`؛ به Scheduler/Pipeline وصل نیست؛ VERIFIED نیست (محیط واقعی ندارد) |
| Setup Engine R1 | TESTED (CI) | وصل به runtime نیست؛ R1 هنوز تأیید نشده |
| ماشین حالت | TESTED (CI) | ابهام ۸/۹ بالا |

## تست‌ها: کدام روی PostgreSQL واقعی اجرا شد
| سطح | فایل | وضعیت |
|---|---|---|
| PostgreSQL 17 (سرویس CI، `DB_PROBE=true`، postgres.js) | `audit.postgres.test.ts`، `e2e.scenarios.test.ts` (اجرای Postgres)، `ingest.integration.test.ts`، `api/queries/database.integration.test.ts` | سبز در CI برای `08e7c00` |
| PostgreSQL 17 برای agent_runs | `agentRuns.postgres.test.ts` | **هنوز در CI اجرا نشده**؛ نتیجهٔ CI پس از push ثبت می‌شود |
| PostgreSQL 16.15 محلی، psql واقعی (نه postgres.js) | قرارداد agent_runs، ۲۵ تست | ۲۵/۲۵ پاس (دستی، خارج از مخزن) |
| داده واقعی fixture (۹۹۹ کندل BTCUSDT 1h) | `agentRuns.test.ts`، `setupEngine.test.ts` | پاس محلی |
| in-memory / fake executor (دیتابیس واقعی نیست) | `agentRuns.test.ts` (بخش fake)، سایر | پاس |

## اتصال Pipeline (برنامهٔ P0–P7، تأییدشده ۴ نوامبر ۲۰۲۶)
قرارداد و تصمیم‌ها: `docs/PIPELINE_CONTRACT.md`. وضعیت مراحل (برچسب‌های مجاز): P0 مستند (IMPLEMENTED) · P1 تا P6 در حال اجرا (IN PROGRESS) · P7 NOT STARTED و نیازمند مجوز جدا. ۸/۹ state، اسلات عامل‌ها، Delta Force، B15، R1 و Setup حالت Trend همچنان BLOCKED/تأییدنشده‌اند.
