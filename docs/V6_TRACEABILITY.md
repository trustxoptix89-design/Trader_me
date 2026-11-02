# ماتریس تطبیق الزامات سند V6 با کد (ممیزی روی `a0d8f46`، شاخه `phase-e-integration`)

برچسب‌ها: IMPLEMENTED / TESTED / VERIFIED / PARTIAL / NOT IMPLEMENTED / BLOCKED.
TESTED = تست خودکار سبز در CI. VERIFIED = شاهد اجرای واقعی در محیط هدف (فقط جایی که واقعاً وجود دارد).
مرجع تصمیم: V6. تناقض‌ها در بخش آخر؛ هیچ قانون جدیدی ساخته نشده است.

## فاز A — داده
| الزام V6 | وضعیت | شاهد / شکاف |
|---|---|---|
| زنجیرهٔ منبع CoinGecko→CryptoCompare→Binance public→Yahoo، BLOCKED_SOURCE_DATA | TESTED | `api/ingest/ingest.ts runCascade`, `ingest.test.ts`؛ اجرای زندهٔ قبلی فقط در CI (`e2e-live.yml`) |
| تازگی/stale، dedupe، ثبت gap | TESTED | `computeFreshness`, `sanitizeCandles`, `findGaps` |
| جدول candles در DB واقعی | TESTED | migration 0002 + `ingest.integration.test.ts` (PG در CI) |
| داده 5m/15m/1h/4H مستقل از حساب صرافی | PARTIAL | CoinGecko فقط 30m/1h/4h؛ 5m/15m به Binance public/CryptoCompare/Yahoo وابسته است؛ اجرای زنده در شبکهٔ فعلی ممکن نیست (فقط CI) |
| rate limit 60 req/min | TESTED | `createRateLimiter` در `/api/candles` (روی `/api/health` اعمال نشده) |

## فاز B — اندیکاتورها
| الزام | وضعیت | شاهد |
|---|---|---|
| ۸ اندیکاتور با امضای مشترک `IndicatorResult` در فایل‌های جدا (`indicators/{rsi,macd,...}.ts`) | PARTIAL | محاسبات هست (`contracts/indicators.ts`, `api/engines/indicators.ts`, `deltaforce.*`) اما ساختار فایل/امضای V6 رعایت نشده |
| جدول طلایی ۳ نقطه‌ای | TESTED | `golden.test.ts` |
| BOS/CHoCH fractal N=5، S/R pivot k=3، sweep | PARTIAL | سه تابع ساختاری در کد هست؛ تطبیق خط‌به‌خط پارامترها با V6 بررسی نشده |
| ADX/FVG/OB/POC-VAH-VAL/RVOL/StochRSI (پیوست ۱) | NOT IMPLEMENTED (ADX قدیمی منحرف از TA-Lib) | — |

## فاز C — عوامل
| الزام | وضعیت | شاهد |
|---|---|---|
| ≥۱۰ عامل واقعی با قالب YAML | NOT IMPLEMENTED | ۶ عامل در `agents.ts`/`deltaAgent.ts` (A01, B09–B12, Delta)؛ هیچ YAML ندارد |
| ۳۳ عامل (A01–E33) | PARTIAL: 6 از 33 | ۲۷ مورد وجود ندارد؛ stub برچسب‌دار هم نیست |

## فاز D — اتاق‌ها و حاکمیت
| الزام | وضعیت | شاهد |
|---|---|---|
| ماشین حالت ۸ مرحله‌ای + guard | TESTED | `machine.ts`, `hardening.test.ts` (233 تست CI) |
| POST_MORTEM پس از اجرا | NOT IMPLEMENTED | — |
| Data/Error/Chart Quality/Risk/Approval | TESTED (Error Detection: PARTIAL — قواعد MACD/RSI و BOS-vs-EMA200 نیست) | `rooms.ts`, `chartQuality.ts`, `approval.ts` |
| Independent Verifier با VETO مطلق | TESTED | `verifier.ts`، تست ایمپورت مستقل |
| Delta Force وزن ۳ در ULTRA_TREND، Range Mode | TESTED | `governance.test.ts` |
| Board + Supervisory Board (نمونه‌گیری هر ۱۰ سیگنال، PAUSED_PIPELINE) | NOT IMPLEMENTED | — |
| Post-Mortem Loop (agent_weights هر ۲۰ نتیجه) | NOT IMPLEMENTED | — |
| `/admin/org-health` | NOT IMPLEMENTED | — |
| Audit append-only + hash chain | TESTED (PG واقعی در CI) | `audit.postgres.ts`, `AUDIT_LOG.md`؛ محدودیت: owner/superuser می‌تواند تریگر را غیرفعال کند (تشخیص، نه جلوگیری) |
| اتصال PostgresAuditStore به runtime | IMPLEMENTED در این شاخه (`orchestrator/runtime.ts`)؛ **Scheduler هنوز `runSignalPipeline` را اصلاً صدا نمی‌زند** (از `analyzeMarket` قدیمی استفاده می‌کند) | بلوکر بعدی |
| نقش محدود DB (SELECT/INSERT) در استقرار | PARTIAL | فقط در تست نشان داده شده؛ اعمال در production نیازمند تأیید شما |
| schema ردیف `audit_log` مطابق §6 | PARTIAL | ستون‌ها متفاوت‌اند (تناقض T-1 زیر) |

## فاز E–H
| الزام | وضعیت | شاهد |
|---|---|---|
| TradingView + Lightweight Charts + overlay سیگنال | PARTIAL | `TradingViewChart.tsx`, `MarketChart.tsx`؛ overlay سیگنال/اسکرین‌شات ندارد |
| بک‌تست: walk-forward، Wilson، کارمزد/slippage/funding، اثرانگشت | TESTED (PARTIAL نسبت به V6: وابسته به استراتژی ema-rsi-atr قدیمی، نه خروجی خط لولهٔ جدید) | `backtest.ts`, `engines.test.ts`, `backtestFingerprint` |
| `/health` JSON با فیلدهای V6 | IMPLEMENTED (این شاخه: `routes/health.ts`)؛ تست CI | TESTED پس از سبز شدن CI |
| هشدار آزمایشی واقعی Telegram/log | PARTIAL | فقط Web Push+جدول notifications؛ Telegram نیست؛ تست هشدار واقعی انجام نشده |
| استقرار عمومی (Render/Cloudflare/Netlify) | NOT STARTED/NOT VERIFIED | نیاز به تأیید شما (حساب/هزینه) |
| README تحویل | PARTIAL | جدول وضعیت هست؛ راهنمای تحویل کامل نیست |

## چک‌لیست پذیرش §14 (خلاصه)
فرانت‌اند عمومی: NOT IMPLEMENTED(استقرار) · داده واقعی در DB: TESTED (CI)، VERIFIED نشده · اندیکاتورها: PARTIAL · BOS/S-R: PARTIAL · ≥۱۰ عامل YAML: NOT IMPLEMENTED · ۳ اتاق: TESTED · Chart Quality+Approval: TESTED · VETO: TESTED · pipeline اسپات+فیوچرز: PARTIAL (در تست‌ها؛ در runtime وصل نیست) · audit ۸ مرحله: TESTED (PG) · post-mortem: NOT IMPLEMENTED · org-health: NOT IMPLEMENTED · overlay: NOT IMPLEMENTED · بک‌تست بازتولیدپذیر: TESTED · health 200: IMPLEMENTED→TESTED پس از CI · هشدار آزمایشی: NOT VERIFIED · README: PARTIAL · بلوکرهای مستند: این سند.

## تناقض‌ها (نیازمند تأیید شما، بدون ابداع قانون)
- T-1: ستون‌های `audit_log` در §6 (signal_id/state/room/verdict/reason/input_hash/output_hash/timestamp/idempotency_key) با طرح فعلی (زنجیرهٔ hash + seq) فرق دارد. پیشنهاد: نگاشت view سازگار با §6.
- T-2 (D-3): Delta CONFLICT → توقف در RECONCILED در پیاده‌سازی، با V2 هم‌خوان نیست.
- T-3: شروع تنظیم آستانه‌ها: همهٔ پارامترهای فعلی REFERENCE/PROPOSED‌اند و EMPIRICAL ندارند.
- T-4: ساخت setup (entry/stop/target) برای خط لولهٔ جدید در V6 تعریف دقیق ندارد؛ اتصال Scheduler به pipeline بدون این تعریف قانون جدید می‌سازد → نیاز به تصمیم شما.
