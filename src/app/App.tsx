import { AppStateProvider, useAppState } from "./AppState";
import { Shell } from "./Shell";
import { ComparisonsPage } from "./pages/ComparisonsPage";
import { CoveragePage } from "./pages/CoveragePage";
import { ImportPage } from "./pages/ImportPage";
import { LibraryPage } from "./pages/LibraryPage";
import { MetricsExplorerPage } from "./pages/MetricsExplorerPage";
import { OverviewPage } from "./pages/OverviewPage";
import { RegressionPage } from "./pages/RegressionPage";

function ActivePage() {
  const { view } = useAppState();
  if (view === "library") return <LibraryPage />;
  if (view === "overview") return <OverviewPage />;
  if (view === "coverage") return <CoveragePage />;
  if (view === "explorer") return <MetricsExplorerPage />;
  if (view === "regression") return <RegressionPage />;
  if (view === "comparisons") return <ComparisonsPage />;
  return <ImportPage />;
}

export function App() {
  return (
    <AppStateProvider>
      <Shell>
        <ActivePage />
      </Shell>
    </AppStateProvider>
  );
}
