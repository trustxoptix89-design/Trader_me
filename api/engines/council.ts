import { createHash } from "node:crypto";
import type { Direction, MarketMetrics, MarketSnapshot, RiskAssessment, RoleReview, Verdict } from "@contracts/types";

export interface CouncilContext {
  direction: Direction | null;
  risk: RiskAssessment;
  macro: { available: boolean; safe: boolean; details: string[] };
  strategy: { available: boolean; approved: boolean; details: string[] };
  correlatedPositions?: number;
  maxCorrelatedPositions?: number;
}

const roles = [
  ["پایش یکپارچگی داده", "observer", "کنترل ترتیب زمانی، تکرار، OHLC و حجم منفی"],
  ["پایش تازگی داده", "observer", "سنجش سن آخرین کندل نسبت به تایم‌فریم"],
  ["پایش هم‌راستایی تایم‌فریم", "observer", "مقایسهٔ روند تایم‌فریم اجرا با ۴ ساعته"],
  ["پایش رژیم بازار", "observer", "تفکیک روند از رنج با EMA و ADX"],
  ["کارشناس روند", "observer", "جهت EMA20/50 و موقعیت قیمت"],
  ["کارشناس ساختار بازار", "observer", "مقایسهٔ سقف و کف‌های دو پنجرهٔ اخیر"],
  ["کارشناس پرایس‌اکشن", "observer", "بسته‌شدن قیمت و مومنتوم MACD"],
  ["کارشناس حمایت و مقاومت", "observer", "فاصلهٔ قیمت از کف و سقف ۴۸ کندل"],
  ["کارشناس حجم", "observer", "نسبت حجم جاری به میانگین ۲۰ کندل قبل"],
  ["کارشناس نوسان", "observer", "ATR و نوسان تحقق‌یافته برای توقف شرایط غیرعادی"],
  ["کارشناس نقدینگی", "expert", "ارزش دلاری حجم کندل و کف نقدینگی"],
  ["کارشناس مشتقات", "expert", "اعتبار Mark Price و انحراف آن از Close"],
  ["کارشناس Funding", "expert", "فیلتر نرخ فاندینگ شدید در جهت معامله"],
  ["کارشناس Open Interest", "expert", "تأیید تغییر OI همراه با جهت پیشنهادی"],
  ["کارشناس همبستگی موقعیت‌ها", "expert", "کنترل تعداد موقعیت‌های همبستهٔ باز"],
  ["کارشناس کلان و اخبار", "expert", "بررسی دسترسی، تازگی و پنجرهٔ رویداد پرریسک"],
  ["داور آمار استراتژی", "expert", "وجود بک‌تست معتبر و نتیجهٔ خارج از نمونه"],
  ["داور هزینهٔ اجرا", "expert", "سنجش کارمزد، لغزش و اسپرد نسبت به ریسک"],
  ["کنترل مستقل ریسک", "expert", "حد ضرر، R:R، اهرم، زیان روزانه و ریسک تجمعی"],
  ["دبیر نهایی شورا", "expert", "تأیید فقط با رأی مثبت هر ۱۹ بررسی قبلی"],
] as const;

export function runCouncil(snapshot: MarketSnapshot, m: MarketMetrics, context: CouncilContext): RoleReview[] {
  const version = createHash("sha256").update(JSON.stringify({ t: snapshot.candles.at(-1)?.time, m, d: context.direction })).digest("hex").slice(0, 16);
  const reviews: RoleReview[] = [];
  const direction = context.direction;
  const add = (index: number, verdict: Verdict, reasonsFor: string[], reasonsAgainst: string[], dataUsed: string[], limitations: string[] = []) => {
    const [role, category, method] = roles[index];
    reviews.push({ role, category, method, verdict, reasonsFor, reasonsAgainst, limitations, dataUsed, reviewedAt: Date.now(), analysisVersion: version });
  };
  const aligned = direction !== null && ((direction === "long" && m.trend === "bullish" && m.higherTrend === "bullish") || (direction === "short" && m.trend === "bearish" && m.higherTrend === "bearish"));
  const ordered = snapshot.candles.every((c, i, a) => i === 0 || c.time > a[i - 1].time) && snapshot.candles.every((c) => c.high >= c.low && c.open > 0 && c.close > 0 && c.volume >= 0);
  add(0, ordered && snapshot.candles.length >= 200 ? "approve" : "reject", ordered ? ["ترتیب و ساخت OHLCV معتبر است"] : [], ordered ? snapshot.candles.length < 200 ? ["حداقل ۲۰۰ کندل لازم است"] : [] : ["ناسازگاری در OHLCV یا ترتیب زمانی"], ["OHLCV", `${snapshot.candles.length} candles`]);
  add(1, snapshot.isFresh ? "approve" : "reject", snapshot.isFresh ? ["داده در پنجرهٔ تازگی قرار دارد"] : [], snapshot.isFresh ? [] : ["داده کهنه است"], ["closeTime", "fetchedAt"]);
  add(2, aligned ? "approve" : "reject", aligned ? [`روند ۱۵ دقیقه و ۴ ساعته با ${direction} هم‌راستاست`] : [], aligned ? [] : ["روند تایم‌فریم‌ها هم‌راستا نیست یا جهت اولیه وجود ندارد"], ["15m EMA", "4h EMA"], snapshot.higherTimeframes["4h"] ? [] : ["دادهٔ ۴ ساعته موجود نیست"]);
  const regimeOk = aligned && (m.adx14 ?? 0) >= 18;
  add(3, regimeOk ? "approve" : "reject", regimeOk ? [`رژیم روندی با ADX ${m.adx14?.toFixed(1)}`] : [], regimeOk ? [] : ["ADX زیر ۱۸ یا روند نامعتبر است"], ["ADX14", "EMA20/50"]);
  const trendOk = aligned && m.ema20 !== null && m.ema50 !== null && ((direction === "long" && m.price > m.ema20 && m.ema20 > m.ema50) || (direction === "short" && m.price < m.ema20 && m.ema20 < m.ema50));
  add(4, trendOk ? "approve" : "reject", trendOk ? ["قیمت و میانگین‌ها جهت را تأیید می‌کنند"] : [], trendOk ? [] : ["ترتیب قیمت و EMA جهت را تأیید نمی‌کند"], ["Close", "EMA20", "EMA50"]);
  const structureOk = (direction === "long" && m.structure === "higher-highs") || (direction === "short" && m.structure === "lower-lows");
  add(5, structureOk ? "approve" : "reject", structureOk ? ["سقف/کف‌های ساختاری هم‌جهت‌اند"] : [], structureOk ? [] : [`ساختار ${m.structure} است`], ["12 swing candles"]);
  const macdOk = (direction === "long" && (m.macdHistogram ?? 0) > 0) || (direction === "short" && (m.macdHistogram ?? 0) < 0);
  add(6, macdOk ? "approve" : "reject", macdOk ? ["هیستوگرام MACD با جهت هم‌علامت است"] : [], macdOk ? [] : ["مومنتوم MACD تأیید نمی‌کند"], ["EMA12/26", "MACD signal 9"]);
  const atr = m.atr14 ?? 0;
  const roomOk = direction !== null && m.support !== null && m.resistance !== null && (direction === "long" ? m.resistance - m.price > atr : m.price - m.support > atr);
  add(7, roomOk ? "approve" : "reject", roomOk ? ["تا مانع نزدیک بیش از یک ATR فاصله است"] : [], roomOk ? [] : ["فضای حرکت تا حمایت/مقاومت کافی نیست"], ["48-bar high/low", "ATR14"]);
  const volumeOk = (m.volumeRatio ?? 0) >= 0.8;
  add(8, volumeOk ? "approve" : "reject", volumeOk ? [`نسبت حجم ${m.volumeRatio?.toFixed(2)} است`] : [], volumeOk ? [] : ["حجم نسبت به میانگین کمتر از ۰٫۸ است"], ["Volume", "20-bar average"]);
  const volatilityOk = m.atrPct !== null && m.atrPct > 0.05 && m.atrPct < 10;
  add(9, volatilityOk ? "approve" : "reject", volatilityOk ? ["نوسان در محدودهٔ قابل ارزیابی است"] : [], volatilityOk ? [] : ["ATR خیلی کم یا غیرعادی است"], ["ATR14/price", "realized volatility"]);
  const liquidityOk = (m.liquidityUsd ?? 0) >= 100_000;
  add(10, liquidityOk ? "approve" : "reject", liquidityOk ? ["گردش کندل از کف ۱۰۰ هزار دلار بیشتر است"] : [], liquidityOk ? [] : ["گردش کندل ناکافی یا ناموجود است"], ["quoteVolume", "volume×close"]);
  const mark = snapshot.derivatives.markPrice;
  const deviation = mark ? Math.abs(mark / m.price - 1) * 100 : Infinity;
  const derivativesOk = mark !== null && deviation < 0.3;
  add(11, derivativesOk ? "approve" : "reject", derivativesOk ? [`انحراف Mark/Close برابر ${deviation.toFixed(3)}٪ است`] : [], derivativesOk ? [] : ["Mark Price ناموجود یا دارای انحراف غیرعادی است"], ["premiumIndex/ticker", "Close"]);
  const funding = snapshot.derivatives.fundingRate;
  const fundingOk = funding !== null && Math.abs(funding) < 0.005 && !(direction === "long" && funding > 0.002) && !(direction === "short" && funding < -0.002);
  add(12, fundingOk ? "approve" : "reject", fundingOk ? ["فاندینگ در جهت معامله اشباع نیست"] : [], fundingOk ? [] : ["Funding ناموجود، شدید یا در جهت معامله اشباع است"], ["fundingRate"]);
  const oi = snapshot.derivatives.openInterestChangePct;
  const oiOk = oi !== null && ((direction === "long" && oi > -1) || (direction === "short" && oi < 1));
  add(13, oiOk ? "approve" : "reject", oiOk ? [`تغییر OI برابر ${oi?.toFixed(2)}٪ است`] : [], oiOk ? [] : ["تغییر OI ناموجود یا با جهت ناسازگار است"], ["openInterest history ~150m"], ["OI به‌تنهایی ورود یا خروج سرمایه را اثبات نمی‌کند"]);
  const correlated = context.correlatedPositions ?? 0, maxCorrelated = context.maxCorrelatedPositions ?? 1;
  add(14, correlated < maxCorrelated ? "approve" : "reject", correlated < maxCorrelated ? ["ریسک همبستگی موقعیت‌ها ظرفیت دارد"] : [], correlated < maxCorrelated ? [] : ["سقف موقعیت‌های همبسته تکمیل است"], ["open paper positions", "risk settings"], ["همبستگی بر اساس دارایی/جهت موقعیت‌های باز است، نه ضریب تاریخی"]);
  add(15, context.macro.available && context.macro.safe ? "approve" : "reject", context.macro.available && context.macro.safe ? context.macro.details : [], context.macro.available && context.macro.safe ? [] : context.macro.details, ["RSS/news timestamps", "event risk window"]);
  add(16, context.strategy.available && context.strategy.approved ? "approve" : "reject", context.strategy.available && context.strategy.approved ? context.strategy.details : [], context.strategy.available && context.strategy.approved ? [] : context.strategy.details, ["versioned backtest", "out-of-sample metrics"]);
  const costsOk = context.risk.estimatedFees !== null && context.risk.riskAmount !== null && context.risk.estimatedFees < context.risk.riskAmount * 0.5;
  add(17, costsOk ? "approve" : "reject", costsOk ? ["کارمزد تخمینی کمتر از نیمی از بودجهٔ ریسک است"] : [], costsOk ? [] : ["هزینهٔ اجرا نسبت به ریسک زیاد یا نامشخص است"], ["feePct", "slippagePct", "spreadPct"], ["لغزش و اسپرد فرض محافظه‌کارانه‌اند، نه دادهٔ تاریخی order book"]);
  add(18, context.risk.approved ? "approve" : "reject", context.risk.approved ? ["تمام حدود ریسک عبور کرد"] : [], context.risk.approved ? [] : context.risk.reasons, ["risk engine", "daily loss", "leverage", "portfolio risk"]);
  const failed = reviews.filter((r) => r.verdict !== "approve");
  add(19, failed.length === 0 ? "approve" : "reject", failed.length === 0 ? ["هر ۱۹ نقش قبلی تأیید کردند"] : [], failed.length ? [`${failed.length} مخالفت یا ابهام حل‌نشده: ${failed.map((r) => r.role).join("، ")}`] : [], ["19 independent software reviews"], ["نقش‌ها ماژول‌های نرم‌افزاری مستقل‌وظیفه‌اند؛ ایجنت‌های مستقل یا مدل‌های جداگانه نیستند"]);
  return reviews;
}
