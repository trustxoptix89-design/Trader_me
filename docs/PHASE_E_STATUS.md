# وضعیت فاز E (۷ نوامبر ۲۰۲۶)

برچسب‌های مجاز: NOT STARTED / IN PROGRESS / IMPLEMENTED / TESTED / VERIFIED / BLOCKED.

## اجزای پیاده‌شده (شاهد)
| جزء | وضعیت | شاهد |
|---|---|---|
| عمق تاریخچه (docs/HISTORY_DEPTH.md) | VERIFIED (داده ۱H واقعی برای اندازه‌گیری؛ سایر TFها SYNTHETIC) | CI run 42308643299 (a3d6e64) |
| مسئولیت‌پذیری خطای Agent (PIPELINE_CONTRACT §11) | VERIFIED (حافظه‌ای/SYNTHETIC؛ اتمی‌بودن PG از P3) | CI run 42309063164 (5fa8167) |
| ماشین حالت: oracle هر جفت، fault-injection هر نوشتن، گاردهای approval | VERIFIED | stateMachineGuards.test.ts، CI سبز |
| Outbox (idempotency، backoff، DEAD، lease، لاگ تحویل) | TESTED تا P5 | CI run 42092683207 |

## بلاکرهای مستقل (هر کدام علت دقیق)
| جزء | وضعیت | علت و اقدام بعدی |
|---|---|---|
| اعتبارسنجی اجرای واقعی Spot | BLOCKED | خروجی شبکه به api.binance.com، data-api.binance.vision و api.bybit.com از این محیط: curl کد 000 (مسدود). DATABASE_URL تنظیم نیست. روش بازتولید بیرونی در پایین. |
| ingest با سقف ۲۰۰ کندل در هر فراخوانی | BLOCKED | نیاز ۳۶۰ کندل بسته (HISTORY_DEPTH). تغییر ingest/provider مجوز نگرفته. گزینه‌ها: انباشت چند فراخوانی در طول زمان، یا مجوز بالابردن سقف. |
| قاعدهٔ R1 (setupEngine) | BLOCKED | قاعدهٔ استراتژی منتظر تأیید کاربر؛ V6 فرمول Entry/SL/TP تعریف نکرده؛ ابداع آستانه ممنوع. |
| Setup حالت Trend | BLOCKED | الگوریتم در V6 تعریف نشده و تابع runner برای Trend ABSTAIN (`TREND_SETUP_UNAVAILABLE`) می‌دهد؛ تا تأیید R1 یا تعریف رسمی، ساخته نمی‌شود. |
| Futures | BLOCKED | منبع داده انتخاب/تأیید نشده (PIPELINE_CONTRACT §9)؛ Spot و Futures جدا؛ منبع جعلی ساخته نمی‌شود. |
| اسلات Delta Force، تعداد state (۸ یا ۹) | BLOCKED | نیاز به تصمیم صریح کاربر؛ شاهدی در قرارداد برای تغییر نیست. |
| کانال اعلان واقعی | BLOCKED | هیچ کانال/کلیدی تأیید نشده؛ فقط `logChannel`. اعلان واقعی تا تأیید گیت‌ها ممنوع. |
| P7 Scheduler | NOT STARTED | خارج از مجوز. |

## روش بازتولید بیرونی اعتبارسنجی Spot (HISTORICAL-REAL/LIVE؛ انجام نشده، ادعای موفقیت ندارد)
1. PostgreSQL با `DATABASE_URL` و `npm run db:migrate` (یا `runMigrations`).
2. ingest برای BTCUSDT در ۴ تایم‌فریم (4h,1h,15m,5m) از منبع در دسترس؛ چون سقف ۲۰۰ است، تا رسیدن به ≥ MIN_CLOSED_CANDLES (360/360/360/120 کندل بسته) تکرار شود.
3. `DB_PROBE=true npx vitest run api/tests/candleReader.postgres.test.ts` برای تأیید خواندن.
4. `npx tsx api/pipeline/cli.ts --symbol BTCUSDT --market spot` و ذخیرهٔ JSON خروجی.
5. بررسی SQL: `signal_decisions` (یا جدول DECISION)، `agent_runs` (۷ ردیف OK یا ERROR مشخص)، `notification_outbox` (فقط برای approved).
برچسب داده را در گزارش بنویسید: تا اجرای واقعی، همه‌چیز SYNTHETIC است.
