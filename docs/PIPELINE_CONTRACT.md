# قرارداد اتصال Pipeline (P0) — تصمیم‌های تأییدشده ۴ نوامبر ۲۰۲۶ و طراحی

وضعیت: **مستند برای بازبینی**. ۸/۹ state، اسلات عامل‌ها، Delta Force، B15 و R1 در این سند دست‌نخورده و BLOCKED می‌مانند. Setup حالت Trend تا الگوریتم رسمی بسته است.

## ۱. کندل بسته‌شده و قابل‌اعتماد
`time` = زمان **شروع** کندل (ms، UTC). کندل فقط وقتی وارد تحلیل می‌شود که همهٔ شرط‌ها برقرار باشد (بدون ثابت اختراعی):

| شرط | قاعده | دلیل رد |
|---|---|---|
| C1 اعتبار زمان | `time` عدد صحیح متناهی و `time % TF_MS == 0` | `MISALIGNED_TIMESTAMP` |
| C2 بسته‌شدن | `time + TF_MS <= now` | `NOT_CLOSED` |
| C3 شواهد نهایی‌شدن | `ingestedAt >= time + TF_MS` | `UNFINALIZED_SNAPSHOT` |
| C4 ساعت | `ingestedAt <= now` و `now` متناهی | `CLOCK_INCONSISTENT` |
| C5 مقدار | OHLCV متناهی، `high>=low`، open و close در [low, high]، volume≥0 | `INVALID_VALUE` |
| C6 یکتایی | `time` تکراری ممنوع | `DUPLICATE_TIME` |
| C7 تازگی | `now - lastClosed.time ≤ 2×TF_MS` (Data Room فعلی) | `DATA_STALE` |

**یافتهٔ کد:** `createPgStore().insertCandles` با `ON CONFLICT DO NOTHING` کار می‌کند؛ کندلی که هنگام تشکیل ذخیره شود با مقادیر ناقص برای همیشه می‌ماند. شرط C3 برای همین است. ردیف‌های پیش از بسته‌شدن حذف می‌شوند و داده به‌صورت کمبود کندل ABSTAIN می‌دهد (امن). اصلاح خود ingest (به‌روزرسانی ردیف‌های ناتمام) در این برنامه انجام نمی‌شود و تأیید جدا می‌خواهد.

## ۲. تایم‌فریم‌ها
| Pipeline | DB | `TF_MS` |
|---|---|---|
| 4H | 4h | 14 400 000 |
| 1H | 1h | 3 600 000 |
| 15m | 15m | 900 000 |
| 5m | 5m | 300 000 |
مرجع تصمیم: 1H. پوشش 4h و 5m توسط هر Provider هنوز UNKNOWN است.

## ۳. حداقل کندل بستهٔ لازم
اعداد قبلی (200/200/200/30) فقط حداقل **تعریفی** ماژول‌ها بود. اندازه‌گیری روی داده واقعی نشان داد اندیکاتورهای بازگشتی تا عمق بیشتری وابسته به seed هستند؛ مرجع جدید: **360 / 360 / 360 / 120** برای 4H / 1H / 15m / 5m (جزئیات، روش و محدودیت‌ها: `docs/HISTORY_DEPTH.md`). حداقل ماژول‌ها همچنان 200/200/200/30 است و پایین‌تر از آن ماژول ABSTAIN می‌دهد. عمق خواندن = لازم + ۱.

## ۴. هویت سیگنال و چرخهٔ Setup
- **signalKey**: `sha256(canonical{contract:1, symbol, market, direction, referenceTimeframe:"1H", lastClosedCandleOpenTime, setupFingerprint, configFingerprint})`. `now` در آن نیست.
- **cycleKey**: `sha256(canonical{symbol, market, direction, referenceTimeframe})`.
- **setupFingerprint**: `sha256(canonical{entry, invalidation, targets, atr})` با استانداردسازی نمایش عدد (`-0→0`، رد NaN/Infinity)، بدون گرد کردن.

رفتار قطعی:
1. همان signalKey دوباره → `duplicate`.
2. کندل بستهٔ بعدی با همان fingerprint → ادامهٔ همان چرخه و نسخه (`CONTINUED`)، بدون رویداد اعلان.
3. تغییر Entry، Stop، Targets یا ساختار (هر اختلاف fingerprint) → نسخهٔ جدید در همان چرخه با تاریخچه؛ نسخهٔ قبلی دست نمی‌خورد.
4. ابطال: کندل بستهٔ 1H که بر خلاف جهت از invalidation عبور کند → چرخه `INVALIDATED`؛ شکل‌گیری بعدی چرخهٔ جدید. جهت مخالف cycleKey جدا دارد.
5. هیچ cooldown زمانی تعریف نشده.

**باز:** آیا نسخهٔ جدید اعلان جدا بدهد؟ در P5 فقط `NEW_CYCLE` و `NEW_VERSION` روی کانال log ثبت می‌شوند. تعریف دیگری از «ابطال» ساخته نمی‌شود.

## ۵. تلورانس Setup
DeltaRange (مرجع): تطابق دقیق پس از استانداردسازی عدد. مقایسهٔ خروجی‌های مستقل: فقط `priceStep` معتبر ابزار؛ بدون آن `UNKNOWN_PRICE_STEP` (رد/ABSTAIN). تلورانس ثابت تعریف نشده.

## ۶. Outbox داخلی
فقط کانال `log`. ضمانت: at-least-once با کلید یکتای `(signal_id, channel, kind)`؛ exactly-once فقط برای کانال داخلی log. مرز تراکنش: `agent_runs` + رویداد audit مرحلهٔ AGENTS_RUN در یک تراکنش؛ DECISION + ردیف Outbox در یک تراکنش؛ ارسال بیرونی با Worker خارج از تراکنش.

## ۷. Runner
CLI یا اجرای داخلی کنترل‌شده. بدون endpoint عمومی جدید و بدون Scheduler (P7 جدا).

## ۸. طبقه‌بندی داده در تست‌ها و گزارش‌ها
`HISTORICAL-REAL` (فایل ثابت داده واقعی) · `LIVE` · `FIXTURE` · `SYNTHETIC` (آزمون منطق زمانی). هر گزارش آن‌ها را جدا می‌آورد و ترکیبشان VERIFIED نمی‌شود.

## ۹. منابع داده Futures (بررسی اولیه، بدون انتخاب)
فقط داده عمومی بدون کلید و حساب صرافی. همه **Needs verification**: صفحات رسمی از این محیط قابل‌خواندن نبود (WebFetch خارج از allowlist) و فقط نتایج جست‌وجوی ثانویه دیده شد.

| منبع | داده | کلید؟ | دسترسی از ایران |
|---|---|---|---|
| Binance USD-M Futures، endpoint عمومی بازار | funding، OI | ادعا: خیر (تأیید نشده) | UNKNOWN |
| Bybit v5 market | funding | UNKNOWN | UNKNOWN |
| Hyperliquid info API | funding، OI | UNKNOWN | UNKNOWN |
هیچ‌کدام انتخاب نشد. Futures در P6 فقط با منبع تأییدشده فعال می‌شود؛ وگرنه BLOCKED می‌ماند و فقط Spot اجرا می‌شود.

## ۱۰. وضعیت مراحل (۵ نوامبر ۲۰۲۶)
| مرحله | وضعیت | شاهد |
|---|---|---|
| P0 قرارداد | IMPLEMENTED (مستند) | همین سند |
| P1 آداپتور کندل | TESTED | CI سبز، PG 17.11 |
| P2 هویت و چرخهٔ Setup | TESTED | CI run 42002822718 |
| P3 تراکنش agent_runs + audit، reconcile | TESTED | CI run 42003385005 |
| P4 یکپارچگی Setup (Range) | TESTED | CI run 42012971981 |
| P5 Outbox داخلی (فقط log) | TESTED | CI run 42092683207، PG 17.11 |
| P-next عمق تاریخچه (docs/HISTORY_DEPTH.md) | VERIFIED (CI run 42308643299) | historyDepth.test.ts |
| P6 Runner CLI + گارد State machine | TESTED (داده SYNTHETIC؛ اجرای زنده BLOCKED) | CI run 42093306727، PG 17.11 |
| P7 Scheduler | NOT STARTED (نیازمند مجوز جدا) | — |
BLOCKED: تعداد state (۸ یا ۹)، Futures (منبع داده انتخاب نشده)، Setup حالت Trend، عمق خواندن مرجع ۵m، اجرای Spot روی داده زندهٔ ۴-تایم‌فریم (بدون شبکه/DB داده در این محیط).

## 11. مسئولیت‌پذیری خطای Agent (P-next)

- هر Agent هویت پایدار دارد (`identify(agentId, group, fn)`؛ `defaultAgents()` همگی هویت‌دارند).
- ماشین هر Agent را در try/catch جدا اجرا می‌کند. خطا، رأیِ امضاشده با شناسهٔ دیگر (`AGENT_IDENTITY_MISMATCH`) یا شناسهٔ تکراری (`AGENT_DUPLICATE_ID`) = خطای ساختاریافته.
- در صورت خطا: ردیف `agent_runs` با `validation_outcome=ERROR` و `error` برای همان Agent (همراه با رأی‌های موفق، اتمی با رویداد AGENTS_RUN با verdict=ERROR)، سپس رویداد ERROR و `finish(inconclusive, "AGENT_FAILURE: <ids>")`. هرگز approved نمی‌شود و اعلان ارسال نمی‌شود.
- Agent بدون هویت (تابع ناشناس) که خطا دهد: هویت و ردیف جعلی ساخته نمی‌شود؛ فقط در detail رویداد با `UNIDENTIFIED_AGENT#i` ثبت می‌شود.
- شناسهٔ تکراری ردیف جدید نمی‌سازد (برخورد با کلید idempotency ردیف OK)؛ فقط در detail ثبت می‌شود.
- تکرار ورودی یکسان = duplicate بدون ردیف اضافه. تست‌ها: `api/tests/agentAccountability.test.ts` (به‌ازای هر ۶ Agent + spoof + duplicate + anonymous + retry).
- محدودیت: اتمی‌بودن روی PG همان P3 است (`agentsRunRecorder.postgres.test.ts`)؛ تست PG اختصاصی ERROR هنوز اضافه نشده.
- قرارداد خروجی (`validateVote`): verdict در {bullish,bearish,neutral,abstain}، confidence عدد متناهی در [0,1]، weight متناهی ≥ 0، reason رشته، group برابر group اعلام‌شده. تخطی = `AGENT_INVALID_OUTPUT` (ردیف ERROR، توقف inconclusive).
- Timeout/Retry: Agentهای فعلی توابع همزمانِ قطعی‌اند؛ تکرار با ورودی یکسان خروجی یکسان می‌دهد، پس Retry بی‌اثر و عمداً وجود ندارد؛ Timeout برای تابع همزمان قابل اجرا نیست (NOT_IMPLEMENTED تا وجود Agent ناهمزمان/شبکه‌ای).
