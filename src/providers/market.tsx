import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { trpc } from "@/providers/trpc";
import type { AnalysisResult, Exchange, Interval } from "@contracts/types";

interface MarketContextValue {
  exchange: Exchange; symbol: string; interval: Interval; result: AnalysisResult | null;
  loading: boolean; error: string | null; lastAttempt: number | null;
  setExchange: (v: Exchange) => void; setSymbol: (v: string) => void; setInterval: (v: Interval) => void;
  refresh: () => Promise<AnalysisResult | null>;
}
const MarketContext = createContext<MarketContextValue | null>(null);

export function MarketProvider({ children }: { children: ReactNode }) {
  const [exchange, setExchange] = useState<Exchange>("binance");
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [interval, setInterval] = useState<Interval>("15m");
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastAttempt, setLastAttempt] = useState<number | null>(null);
  const pending = useRef(false);
  const mutation = trpc.trading.analyze.useMutation();
  const refresh = useCallback(async () => {
    if (pending.current) return null;
    pending.current = true; setError(null); setLastAttempt(Date.now());
    try {
      const data = await mutation.mutateAsync({ exchange, symbol, interval });
      setResult(data); return data;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e)); return null;
    } finally { pending.current = false; }
  }, [exchange, symbol, interval, mutation.mutateAsync]);
  return <MarketContext.Provider value={{ exchange, symbol, interval, result, loading: mutation.isPending, error, lastAttempt, setExchange, setSymbol, setInterval, refresh }}>{children}</MarketContext.Provider>;
}

export function useMarket() {
  const value = useContext(MarketContext);
  if (!value) throw new Error("useMarket must be used inside MarketProvider");
  return value;
}
