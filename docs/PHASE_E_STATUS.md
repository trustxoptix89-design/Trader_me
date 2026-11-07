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
5. بررسی SQL: رویداد DECISION در `audit_log` (kind=DECISION)، `agent_runs` (۷ ردیف OK یا ERROR مشخص)، `notification_outbox` (فقط برای approved).
برچسب داده را در گزارش بنویسید: تا اجرای واقعی، همه‌چیز SYNTHETIC است.

## به‌روزرسانی ۷ نوامبر ۲۰۲۶ (دستور اتصال واقعی اجزا)
| جزء | وضعیت | توضیح |
|---|---|---|
| Data Quality → Runner → رویداد DATA_VALIDATED | TESTED | `runner.ts`: بعد از Candle Reader و قبل از Agentها؛ ناقص/کهنه/گپ/نامعتبر = ABSTAIN `DATA_QUALITY_FAILED`؛ خلاصهٔ کیفیت در detail رویداد حسابرسی (زنجیرهٔ hash) |
| Cycle (`cycle.ts`): Run ID، مدت هر مرحله، retry خواندن (حداکثر caller)، timeout، مدیریت duplicate/concurrent/expired | TESTED (mock درون‌حافظه، SYNTHETIC) | Retry فقط برای مرحلهٔ خواندن؛ مرحلهٔ نوشتن هرگز retry نمی‌شود (جلوگیری از رأی/ردیف تکراری). Timeout فقط روی I/O ناهمزمان؛ مرحلهٔ CPU همزمان قابل قطع نیست. |
| نگاشت ۵ برچسب (`labelOf`) | TESTED | approved→BUY_NOW، rejected→REJECT، inconclusive داده/زیرساخت→INSUFFICIENT_DATA، سایر inconclusive→WAIT. **CONDITIONAL_BUY هرگز تولید نمی‌شود** (قاعدهٔ V6 ندارد). نگاشت WAIT پیشنهادی و منتظر تأیید است. |
| Scheduler خط‌لولهٔ جدید (`pipelineScheduler.ts`) | TESTED (فقط محیط تست) | به boot وصل نیست؛ Scheduler قدیمی (`api/scheduler.ts`) دست‌نخورده. جلوگیری از tick همپوشان، عدم توقف با شکست یک نماد، عدم انتشار مجدد سیگنال. |
| Market Discovery (`marketDiscovery.ts`) | TESTED (منطق خالص)؛ Provider: BLOCKED | هیچ adapter HTTP ارسال نشد. |
| Timeout/Retry واقعی برای خود Agentها | NOT_IMPLEMENTED | Agentها همزمان و قطعی‌اند؛ Timeout/Retry در سطح Runner/Cycle روی I/O اعمال می‌شود. |

### منابع داده (بررسی دسترسی از این محیط، ۷ نوامبر ۲۰۲۶)
curl به همهٔ این‌ها کد 000 (بدون پاسخ): CoinGecko، CoinPaprika، CryptoCompare، Kraken، Coinbase، KuCoin، Gate.io، OKX، Binance، Bybit. بنابراین هیچ Providerی تأیید یا فعال نشد. دسترسی از ایران برای هیچ‌کدام راستی‌آزمایی نشده (Needs verification). Futures: BLOCKED.

### نمونهٔ خروجی Cycle (SYNTHETIC، شکل خروجی؛ داده بازار نیست)
`label=REJECT`, `reason=RISK_REJECT: invalid entry/invalidation/target geometry or ATR`، stages READ(attempts 1, retries 0)+PIPELINE، `statesVisited=DETECTED,DATA_VALIDATED,INDICATORS_READY,AGENTS_RUN,RECONCILED,RISK_CHECKED,RECORDED`، کیفیت ۴ تایم‌فریم ok/fresh، `signal=null`. (اجرای `api/tests/sampleCycle.test.ts` همین JSON را چاپ می‌کند.)

### آزمون‌های PostgreSQL واقعی و داده واقعی برای Cycle
NOT_IMPLEMENTED برای Cycle/Scheduler؛ تست‌های cycle فقط mock هستند. recorderهای PG (P3/P5) جداگانه روی PG 17 تست شده‌اند.
