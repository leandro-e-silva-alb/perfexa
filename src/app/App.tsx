import { AppStateProvider, useAppState } from "./AppState";
import { Shell } from "./Shell";
import { PackageImportPage } from "./pages/PackageImportPage";
import { PackageLibraryPage } from "./pages/PackageLibraryPage";
import { RunExplorerPage } from "./pages/RunExplorerPage";
import { ScenarioBoardPage } from "./pages/ScenarioBoardPage";
import { SizingModelsPage } from "./pages/SizingModelsPage";
import { TestComparePage } from "./pages/TestComparePage";
import { TestMetricsPage } from "./pages/TestMetricsPage";

function ActivePage() {
  const { view } = useAppState();
  if (view === "package-library") return <PackageLibraryPage />;
  if (view === "run-explorer") return <RunExplorerPage />;
  if (view === "scenario-board") return <ScenarioBoardPage />;
  if (view === "test-metrics") return <TestMetricsPage />;
  if (view === "sizing-models") return <SizingModelsPage />;
  if (view === "test-compare") return <TestComparePage />;
  return <PackageImportPage />;
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
