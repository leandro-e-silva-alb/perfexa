import { HashRouter, Navigate, Outlet, Route, Routes } from "react-router-dom";
import { AppStateProvider, useAppState } from "./AppState";
import { Shell } from "./Shell";
import { DashboardPage } from "./pages/DashboardPage";
import { PackageImportPage } from "./pages/PackageImportPage";
import { PackageLibraryPage } from "./pages/PackageLibraryPage";
import { RunExplorerPage } from "./pages/RunExplorerPage";
import { ScenarioBoardPage } from "./pages/ScenarioBoardPage";
import { SizingModelsPage } from "./pages/SizingModelsPage";
import { TestComparePage } from "./pages/TestComparePage";
import { TestMetricsPage } from "./pages/TestMetricsPage";

function HomeRedirect() {
  const { packages, storageReady } = useAppState();
  if (!storageReady) return null;

  return <Navigate to={packages.length > 0 ? "/library" : "/import"} replace />;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/dashboard" element={<DashboardPage />} />
      <Route element={<AppShellRoutes />}>
        <Route path="/" element={<HomeRedirect />} />
        <Route path="/import" element={<PackageImportPage />} />
        <Route path="/library" element={<PackageLibraryPage />} />
        <Route path="/packages/:packageId/scenarios" element={<ScenarioBoardPage />} />
        <Route path="/packages/:packageId/runs" element={<RunExplorerPage />} />
        <Route path="/packages/:packageId/metrics" element={<TestMetricsPage />} />
        <Route path="/packages/:packageId/sizing-models" element={<SizingModelsPage />} />
        <Route path="/packages/:packageId/compare" element={<TestComparePage />} />
        <Route path="*" element={<HomeRedirect />} />
      </Route>
    </Routes>
  );
}

function AppShellRoutes() {
  return (
    <AppStateProvider>
      <Shell>
        <Outlet />
      </Shell>
    </AppStateProvider>
  );
}

export function App() {
  return (
    <HashRouter>
      <AppRoutes />
    </HashRouter>
  );
}
