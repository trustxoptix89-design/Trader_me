import { XMLParser } from "fast-xml-parser";

export interface NewsItem {
  id: string; title: string; url: string; source: string; publishedAt: number | null; receivedAt: number;
  assets: string[]; confidenceLimit: string;
}
export interface MacroEvent { title: string; startTime: number; source: string }

const feeds = [
  { source: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/" },
  { source: "Cointelegraph", url: "https://cointelegraph.com/rss" },
  { source: "Federal Reserve", url: "https://www.federalreserve.gov/feeds/press_all.xml" },
];
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { "user-agent": "EvidenceFutures/1.0 public-news-reader" } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

export async function fetchNews(): Promise<{ items: NewsItem[]; errors: string[] }> {
  const results = await Promise.allSettled(feeds.map(async (feed) => {
    const xml = await fetchText(feed.url), doc = parser.parse(xml);
    const entries = doc.rss?.channel?.item ?? doc.feed?.entry ?? [];
    const list = Array.isArray(entries) ? entries : [entries];
    return list.slice(0, 20).map((item: Record<string, unknown>, index: number): NewsItem => {
      const linkRaw = typeof item.link === "object" && item.link ? (item.link as Record<string, string>)["@_href"] : item.link;
      const dateRaw = item.pubDate ?? item.published ?? item.updated;
      const published = dateRaw ? new Date(String(dateRaw)).getTime() : NaN;
      const title = String(item.title ?? "بدون عنوان");
      return {
        id: String(item.guid ?? linkRaw ?? `${feed.source}-${index}`), title, url: String(linkRaw ?? ""),
        source: feed.source, publishedAt: Number.isFinite(published) ? published : null, receivedAt: Date.now(),
        assets: [...title.matchAll(/\b(BTC|ETH|SOL|Bitcoin|Ethereum|Solana|SEC|Fed|FOMC)\b/gi)].map((m) => m[0]),
        confidenceLimit: "خبر خام رسانه/منبع رسمی است؛ صحت ادعا، ارتباط سببی و اثر قیمت به‌طور خودکار اثبات نشده است.",
      };
    });
  }));
  const items = results.flatMap((r) => r.status === "fulfilled" ? r.value : []);
  const errors = results.flatMap((r, i) => r.status === "rejected" ? [`${feeds[i].source}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`] : []);
  return { items: items.sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0)), errors };
}

function parseIcsDate(value: string): number {
  const clean = value.replace(/^.*:/, "");
  if (/^\d{8}T\d{6}Z$/.test(clean)) return new Date(`${clean.slice(0, 4)}-${clean.slice(4, 6)}-${clean.slice(6, 8)}T${clean.slice(9, 11)}:${clean.slice(11, 13)}:${clean.slice(13, 15)}Z`).getTime();
  if (/^\d{8}$/.test(clean)) return new Date(`${clean.slice(0, 4)}-${clean.slice(4, 6)}-${clean.slice(6, 8)}T12:00:00Z`).getTime();
  return NaN;
}

export async function fetchMacroEvents(): Promise<MacroEvent[]> {
  const xml = await fetchText("https://www.bls.gov/schedule/news_release/bls.ics");
  const events: MacroEvent[] = [];
  for (const block of xml.split("BEGIN:VEVENT").slice(1)) {
    const summary = block.match(/SUMMARY[^:]*:(.+)/)?.[1]?.trim();
    const dtstart = block.match(/^DTSTART.*$/m)?.[0];
    if (summary && dtstart) {
      const time = parseIcsDate(dtstart);
      if (Number.isFinite(time)) events.push({ title: summary.replace(/\\,/g, ","), startTime: time, source: "U.S. Bureau of Labor Statistics" });
    }
  }
  return events;
}

export async function macroAssessment(now = Date.now()): Promise<{ available: boolean; safe: boolean; details: string[] }> {
  const [news, calendar] = await Promise.allSettled([fetchNews(), fetchMacroEvents()]);
  const details: string[] = [];
  if (news.status === "rejected" || news.value.items.length === 0) details.push("جریان اخبار عمومی در دسترس نیست");
  if (calendar.status === "rejected") details.push("تقویم رسمی BLS در دسترس نیست؛ بررسی کلان کامل نیست");
  if (news.status === "fulfilled" && news.value.errors.length) details.push(...news.value.errors);
  if (calendar.status === "fulfilled") {
    const risky = calendar.value.filter((e) => Math.abs(e.startTime - now) <= 60 * 60_000);
    if (risky.length) details.push(...risky.map((e) => `پنجرهٔ پرریسک رویداد: ${e.title}`));
    else details.push("رویداد BLS در پنجرهٔ ±۶۰ دقیقه شناسایی نشد");
  }
  const available = news.status === "fulfilled" && news.value.items.length > 0 && calendar.status === "fulfilled";
  const safe = available && !(calendar.status === "fulfilled" && calendar.value.some((e) => Math.abs(e.startTime - now) <= 60 * 60_000));
  if (available) details.push("پوشش تقویم فقط BLS است؛ سایر رویدادهای جهانی ممکن است پوشش داده نشوند");
  return { available, safe, details };
}
