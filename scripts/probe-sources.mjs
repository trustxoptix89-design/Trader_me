// Measures which public market-data APIs answer from THIS machine's network. Prints one JSON line per source.
const SOURCES = [
  ["binance-spot-vision", "https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=15m&limit=3"],
  ["binance-spot", "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=15m&limit=3"],
  ["binance-futures", "https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=15m&limit=3"],
  ["bybit-linear", "https://api.bybit.com/v5/market/kline?category=linear&symbol=BTCUSDT&interval=15&limit=3"],
  ["okx-swap", "https://www.okx.com/api/v5/market/candles?instId=BTC-USDT-SWAP&bar=15m&limit=3"],
  ["okx-funding", "https://www.okx.com/api/v5/public/funding-rate?instId=BTC-USDT-SWAP"],
  ["bitget-futures", "https://api.bitget.com/api/v2/mix/market/candles?symbol=BTCUSDT&productType=usdt-futures&granularity=15m&limit=3"],
  ["gate-futures", "https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=BTC_USDT&interval=15m&limit=3"],
  ["kucoin-futures", "https://api-futures.kucoin.com/api/v1/kline/query?symbol=XBTUSDTM&granularity=15&from=1700000000000&to=1700003000000"],
  ["mexc-futures", "https://contract.mexc.com/api/v1/contract/kline/BTC_USDT?interval=Min15"],
  ["kraken-spot", "https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=15"],
  ["coinbase-spot", "https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=900"],
  ["hyperliquid-perp", "https://api.hyperliquid.xyz/info", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "candleSnapshot", req: { coin: "BTC", interval: "15m", startTime: Date.now() - 4 * 900000 } }) }],
  ["coingecko", "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd"],
  ["cryptocompare", "https://min-api.cryptocompare.com/data/v2/histominute?fsym=BTC&tsym=USD&limit=3"],
];
for (const [name, url, init] of SOURCES) {
  const t = Date.now();
  let out;
  try {
    const res = await fetch(url, { ...(init ?? {}), signal: AbortSignal.timeout(15000), headers: { "user-agent": "Trader_me-probe/1.0", ...(init?.headers ?? {}) } });
    const text = await res.text();
    let parsed = false; try { JSON.parse(text); parsed = true; } catch {}
    out = { name, status: res.status, ms: Date.now() - t, json: parsed, bytes: text.length, head: res.ok ? "" : text.slice(0, 90).replace(/\s+/g, " ") };
  } catch (e) { out = { name, status: 0, ms: Date.now() - t, error: String(e?.cause?.code ?? e?.message ?? e).slice(0, 80) }; }
  console.log(JSON.stringify(out));
}
