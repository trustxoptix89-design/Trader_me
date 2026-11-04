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
| TF | حداقل | مصرف‌کننده | منبع |
|---|---|---|---|
| 4H | 200 | Delta Trend؛ Range ≥ 35 | `MIN_CANDLES` در `deltaforce.trend.ts`؛ `deltaforce.range.ts` |
| 1H | 200 | Delta Trend؛ Verifier و R1 ≥ 50؛ عامل‌ها ≤ 50 | همان + `MIN_HISTORY` |
| 15m | 200 | Delta Trend | `MIN_CANDLES` |
| 5m | 30 | Delta Range | `deltaforce.range.ts` |
هر عدد با تست «n−1 ← ABSTAIN و n ← مجاز» به رفتار واقعی کد گره می‌خورد. سقف ۲۰۰ کندل `ingest` بدون این محاسبه افزایش نمی‌یابد. حداقل عمق خواندن = لازم + ۱ (کندل در حال تشکیل).

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
