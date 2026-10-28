import { Outlet, Route, Routes } from "react-router";
import { MarketProvider } from "@/providers/market";
import { Shell } from "@/components/Shell";
import Dashboard from "@/pages/Dashboard";
import Login from "@/pages/Login";
import NotFound from "@/pages/NotFound";
import { AssetAnalysisPage, CouncilPage } from "@/pages/AnalysisPages";
import { BacktestPage, PerformancePage } from "@/pages/BacktestPages";
import { AssetsPage, HistoryPage, JournalPage, PaperPage, SignalsPage } from "@/pages/PortfolioPages";
import { AlertsPage, RiskPage } from "@/pages/RiskAlertPages";
import { HealthPage, NewsPage, SettingsPage, SourcesPage } from "@/pages/SystemPages";

function AppLayout() {
  return <MarketProvider><Shell><Outlet /></Shell></MarketProvider>;
}

export default function App() {
  return <Routes>
    <Route path="/login" element={<Login />} />
    <Route element={<AppLayout />}>
      <Route path="/" element={<Dashboard />} />
      <Route path="/assets" element={<AssetsPage />} />
      <Route path="/asset" element={<AssetAnalysisPage />} />
      <Route path="/signals" element={<SignalsPage />} />
      <Route path="/council" element={<CouncilPage />} />
      <Route path="/backtest" element={<BacktestPage />} />
      <Route path="/performance" element={<PerformancePage />} />
      <Route path="/paper" element={<PaperPage />} />
      <Route path="/history" element={<HistoryPage />} />
      <Route path="/journal" element={<JournalPage />} />
      <Route path="/alerts" element={<AlertsPage />} />
      <Route path="/news" element={<NewsPage />} />
      <Route path="/risk" element={<RiskPage />} />
      <Route path="/sources" element={<SourcesPage />} />
      <Route path="/settings" element={<SettingsPage />} />
      <Route path="/health" element={<HealthPage />} />
      <Route path="*" element={<NotFound />} />
    </Route>
  </Routes>;
}
