# بهره‌برداری، سلامت و بازیابی

## راه‌اندازی

1. Node.js 22 و MySQL سازگار آماده کنید.
2. `.env.example` را مبنای تنظیم secretها قرار دهید؛ مقدار واقعی فقط در `.env`/Secret Manager.
3. `npm ci`، سپس `npm run db:push` برای محیط توسعه. در production migration نسخه‌بندی‌شده و پشتیبان لازم است.
4. `npm run check && npm run test && npm run build` و سپس `npm start`.
5. صفحهٔ «سلامت سامانه» و «منابع داده» را بررسی کنید. Database سالم بودن به‌تنهایی به معنی دسترسی صرافی نیست.

## شبکه و ایران

این محصول محدودیت sanctions، فیلترینگ، DNS، TLS یا مسدودسازی IP را دور نمی‌زند. از میزبان با دسترسی قانونی و پایدار به endpointهای عمومی استفاده کنید. Timeout/reset/HTTP خطا باید در health دیده شود. نبود داده خطای عملیاتی است، نه مجوز ساختن قیمت یا سیگنال. RSS و BLS نیز ممکن است در دسترس نباشند؛ در این حالت ورود سیگنال متوقف می‌شود.

## زمان‌بند

حالت پیش‌فرض scheduler داخلی هر ۶۰ ثانیه است. برای یک نمونه کافی است. در چند replica روی یک نمونه فعال بماند و در بقیه `DISABLE_SCHEDULER=true` شود. جایگزین: همه را خاموش و فقط یک cron خارجی `POST /api/jobs/run` را با `Authorization: Bearer $CRON_SECRET` فراخوانی کنید. درخواست بدون secret پیکربندی‌شده 503 و رمز غلط 401 می‌گیرد.

اجرای موفق `lastRunAt`، `lastSuccessAt` و `runCount` را به‌روز می‌کند؛ شکست `lastError` و system event ثبت می‌کند. اعلان‌ها dedupeKey دارند و شمارش نتیجه فقط رکوردهای تازه را شامل می‌شود. Push بدون VAPID ارسال نمی‌شود ولی اعلان سرور حفظ می‌شود.

## پشتیبان‌گیری

قبل از migration، ارتقا یا بازیابی از پایگاه‌داده dump تهیه کنید و بازیابی را روی محیط جدا آزمایش کنید. حداقل پوشش: users، risk settings، watchlist، analyses، backtests، paper trades، journal، alerts، notifications و push subscriptions. رمزهای `.env` در backup معمولی مخزن قرار نگیرند و جداگانه در Secret Manager نسخهٔ امن داشته باشند.

## بازیابی غیرمخرب

1. سرویس را از ترافیک خارج کنید و لاگ خطا و وضعیت health را ثبت کنید.
2. از backup سالم روی یک پایگاه‌دادهٔ جدید restore کنید؛ schema و شمار رکوردها را بسنجید.
3. `DATABASE_URL` را به نسخهٔ بازیابی‌شده تغییر دهید و آزمون `DB_PROBE=true npm run test` را اجرا کنید.
4. `npm run check && npm run test && npm run build` و یک run محافظت‌شدهٔ scheduler انجام دهید.
5. صرافی/اخبار را جدا بررسی کنید؛ شکست شبکه را با تغییر schema یا حذف جدول حل نکنید.

هرگز برای رفع migration روی دادهٔ کاربر `DROP TABLE` یا `db:push --force` اجرا نکنید. MySQL DDL تراکنشی نیست؛ migration نیمه‌کاره باید با introspection، اصلاح schema و migration تازه و کنترل‌شده بازیابی شود.

## عیب‌یابی

- خطای TypeScript/build: خروجی کامل `npm run check` و `npm run build`.
- خطای runtime در Kimi: `/tmp/kimi-logs/app.log` و `/tmp/kimi-logs/dev.log`.
- اتصال DB: `DATABASE_URL`، شبکه، سطح دسترسی و وجود ۱۲ جدول.
- PWA: HTTPS برای Service Worker/Push لازم است؛ localhost استثناست. بعد از تغییر shell، cache version را ارتقا دهید و یک بار hard refresh کنید.
- Push: permission مرورگر، Service Worker، PushManager، VAPID و اعتبار subscription را بررسی کنید. iOS/مرورگرهای ناسازگار ممکن است فقط اعلان داخل سامانه داشته باشند.

## محدودیت‌های شناخته‌شده

- لیکوئید تقریبی و نبود order book/partial fill.
- timezone ضرر روزانه همان timezone سرور است.
- scheduler داخل فرایند قفل توزیع‌شده ندارد.
- تحلیل به دسترسی زندهٔ صرافی و اخبار وابسته است؛ قطعی به معنی no-entry است.
- معاملهٔ واقعی عمداً پیاده‌سازی نشده و هیچ تنظیم مخفی برای فعال‌سازی آن وجود ندارد.
