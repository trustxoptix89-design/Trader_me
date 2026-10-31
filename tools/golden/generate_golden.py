#!/usr/bin/env python3
"""Phase B golden-value generator (reference side of the indicator tests).

Fetches REAL BTCUSDT 1h candles from public, key-less endpoints, freezes them into
fixtures/btcusdt_1h.json and computes reference indicator values into
fixtures/golden_values.json using TA-Lib (plus plain pandas formulas only where
TA-Lib has no equivalent: daily VWAP, StochRSI, RVOL).

This script never imports or calls any code from api/indicators: the reference
and the implementation under test must stay independent.

Exit codes: 0 ok, 2 = BLOCKED_SOURCE_DATA (every source failed), 3 = data unusable.
"""
from __future__ import annotations

import datetime as dt
import json
import math
import platform
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import numpy as np
import pandas as pd
import talib

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "fixtures"
SYMBOL = "BTCUSDT"
TIMEFRAME = "1h"
HOUR_MS = 3_600_000
WANT = 1000
MIN_CANDLES = 600
MIN_POINT_INDEX = 400  # keep sample points far past every indicator warm-up


def http_get(url: str, timeout: int = 20):
    req = urllib.request.Request(url, headers={"User-Agent": "sarmaye-golden/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.status, json.loads(resp.read().decode("utf-8"))


def binance_klines(base: str):
    def fetch():
        status, data = http_get(f"{base}/api/v3/klines?symbol={SYMBOL}&interval=1h&limit=1000")
        rows = [
            {
                "time": int(k[0]),
                "closeTime": int(k[6]),
                "open": float(k[1]),
                "high": float(k[2]),
                "low": float(k[3]),
                "close": float(k[4]),
                "volume": float(k[5]),
            }
            for k in data
        ]
        return status, rows

    return fetch


def cryptocompare():
    status, data = http_get("https://min-api.cryptocompare.com/data/v2/histohour?fsym=BTC&tsym=USDT&limit=1000")
    rows = [
        {
            "time": int(r["time"]) * 1000,
            "closeTime": int(r["time"]) * 1000 + HOUR_MS - 1,
            "open": float(r["open"]),
            "high": float(r["high"]),
            "low": float(r["low"]),
            "close": float(r["close"]),
            "volume": float(r["volumefrom"]),
        }
        for r in data["Data"]["Data"]
    ]
    return status, rows


def yahoo():
    status, data = http_get("https://query1.finance.yahoo.com/v8/finance/chart/BTC-USD?interval=1h&range=60d")
    res = data["chart"]["result"][0]
    q = res["indicators"]["quote"][0]
    rows = []
    for i, ts in enumerate(res["timestamp"]):
        vals = [q["open"][i], q["high"][i], q["low"][i], q["close"][i], q["volume"][i]]
        if any(v is None for v in vals):
            continue
        rows.append(
            {
                "time": int(ts) * 1000,
                "closeTime": int(ts) * 1000 + HOUR_MS - 1,
                "open": float(vals[0]),
                "high": float(vals[1]),
                "low": float(vals[2]),
                "close": float(vals[3]),
                "volume": float(vals[4]),
            }
        )
    return status, rows


SOURCES = [
    ("binance_vision", binance_klines("https://data-api.binance.vision")),
    ("binance", binance_klines("https://api.binance.com")),
    ("cryptocompare", cryptocompare),
    ("yahoo_btc_usd", yahoo),
]


def fetch_cascade():
    attempts = []
    for name, fn in SOURCES:
        for attempt in (1, 2):  # one retry, then next source (spec section 4, Phase A)
            try:
                status, rows = fn()
                if len(rows) < MIN_CANDLES:
                    raise ValueError(f"only {len(rows)} candles")
                attempts.append({"source": name, "attempt": attempt, "http_status": status, "ok": True})
                return name, status, rows, attempts
            except urllib.error.HTTPError as exc:
                attempts.append({"source": name, "attempt": attempt, "ok": False, "error": f"HTTP {exc.code}"})
            except Exception as exc:  # noqa: BLE001 - recorded verbatim as evidence
                attempts.append({"source": name, "attempt": attempt, "ok": False, "error": f"{type(exc).__name__}: {exc}"})
            time.sleep(2)
    print("BLOCKED_SOURCE_DATA", json.dumps(attempts, indent=2))
    sys.exit(2)


def clean(rows):
    now_ms = int(time.time() * 1000)
    seen = {}
    for r in rows:
        if r["closeTime"] > now_ms:  # candle still forming
            continue
        if not (r["high"] >= r["low"] and r["low"] <= r["close"] <= r["high"] and r["low"] <= r["open"] <= r["high"] and r["volume"] >= 0):
            continue
        seen[r["time"]] = r
    rows = [seen[t] for t in sorted(seen)]
    # keep the longest contiguous tail so every indicator sees an unbroken series
    start = 0
    for i in range(1, len(rows)):
        if rows[i]["time"] - rows[i - 1]["time"] != HOUR_MS:
            start = i
    rows = rows[start:][-WANT:]
    if len(rows) < MIN_CANDLES:
        print(f"DATA_UNUSABLE: only {len(rows)} contiguous closed candles")
        sys.exit(3)
    return rows


def reference_series(rows):
    close = np.array([r["close"] for r in rows], dtype=float)
    high = np.array([r["high"] for r in rows], dtype=float)
    low = np.array([r["low"] for r in rows], dtype=float)
    vol = np.array([r["volume"] for r in rows], dtype=float)

    macd, macd_signal, macd_hist = talib.MACD(close, 12, 26, 9)
    bb_upper, bb_mid, bb_lower = talib.BBANDS(close, 20, 2, 2, 0)
    rsi = talib.RSI(close, 14)

    rsi_s = pd.Series(rsi)
    lo = rsi_s.rolling(14).min()
    hi = rsi_s.rolling(14).max()
    stoch_k = (rsi_s - lo) / (hi - lo) * 100.0
    stoch_d = stoch_k.rolling(3).mean()

    day = pd.to_datetime(pd.Series([r["time"] for r in rows]), unit="ms", utc=True).dt.floor("D")
    typical = (high + low + close) / 3.0
    pv = pd.Series(typical * vol)
    vwap = pv.groupby(day).cumsum() / pd.Series(vol).groupby(day).cumsum()

    vol_s = pd.Series(vol)
    rvol = vol_s / vol_s.rolling(20).mean()

    return {
        "rsi14": rsi,
        "ema20": talib.EMA(close, 20),
        "ema50": talib.EMA(close, 50),
        "ema200": talib.EMA(close, 200),
        "macd": macd,
        "macd_signal": macd_signal,
        "macd_hist": macd_hist,
        "atr14": talib.ATR(high, low, close, 14),
        "bb_mid": bb_mid,
        "bb_upper": bb_upper,
        "bb_lower": bb_lower,
        "adx14": talib.ADX(high, low, close, 14),
        "plus_di": talib.PLUS_DI(high, low, close, 14),
        "minus_di": talib.MINUS_DI(high, low, close, 14),
        "stochrsi_k": stoch_k.to_numpy(),
        "stochrsi_d": stoch_d.to_numpy(),
        "vwap_daily": vwap.to_numpy(),
        "rvol20": rvol.to_numpy(),
    }


def main():
    FIXTURES.mkdir(exist_ok=True)
    source, status, raw, attempts = fetch_cascade()
    rows = clean(raw)
    series = reference_series(rows)

    rng = np.random.default_rng(42)
    pool = np.arange(MIN_POINT_INDEX, len(rows) - 1)
    picked = sorted(int(i) for i in rng.choice(pool, size=3, replace=False))
    picked.append(len(rows) - 1)  # always include the most recent closed candle

    points = []
    for i in picked:
        values = {}
        for key, arr in series.items():
            v = float(arr[i])
            if not math.isfinite(v):
                print(f"DATA_UNUSABLE: {key} not finite at index {i}")
                sys.exit(3)
            values[key] = v
        points.append(
            {
                "index": i,
                "time": rows[i]["time"],
                "iso": dt.datetime.fromtimestamp(rows[i]["time"] / 1000, dt.timezone.utc).isoformat(),
                "values": values,
            }
        )

    meta = {
        "symbol": SYMBOL,
        "timeframe": TIMEFRAME,
        "source": source,
        "source_http_status": status,
        "source_attempts": attempts,
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "candle_count": len(rows),
        "first_open_time": rows[0]["time"],
        "last_open_time": rows[-1]["time"],
    }
    (FIXTURES / "btcusdt_1h.json").write_text(
        json.dumps({"meta": meta, "candles": rows}, allow_nan=False, separators=(",", ":")), encoding="utf-8"
    )

    golden = {
        "meta": {
            **meta,
            "reference_library": f"TA-Lib {talib.__version__}",
            "numpy": np.__version__,
            "pandas": pd.__version__,
            "python": platform.python_version(),
            "seed": 42,
            "reference_kind": {
                "ta_lib": [
                    "rsi14", "ema20", "ema50", "ema200", "macd", "macd_signal", "macd_hist", "atr14",
                    "bb_mid", "bb_upper", "bb_lower", "adx14", "plus_di", "minus_di",
                ],
                "pandas_formula_not_library": ["vwap_daily", "stochrsi_k", "stochrsi_d", "rvol20"],
            },
            "definitions": {
                "stochrsi": "k = (RSI - min(RSI,14)) / (max(RSI,14) - min(RSI,14)) * 100 over 14 RSI values incl. current; d = SMA(k,3)",
                "vwap_daily": "cumulative sum(typical*volume)/cumulative sum(volume), typical=(H+L+C)/3, reset at 00:00 UTC",
                "rvol20": "volume / SMA(volume,20), the 20-candle window includes the current candle",
                "bb": "SMA(20) +/- 2 * population standard deviation",
            },
        },
        "points": points,
    }
    (FIXTURES / "golden_values.json").write_text(json.dumps(golden, indent=2, allow_nan=False), encoding="utf-8")
    print(f"OK source={source} http={status} candles={len(rows)} points={[p['iso'] for p in points]}")


if __name__ == "__main__":
    main()
