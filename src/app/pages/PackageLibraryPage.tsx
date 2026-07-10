import { CheckCircle2, Loader2, SlidersHorizontal, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable } from "../../components/DataTable";
import { StatusPill } from "../../components/StatusPill";
import { buildRunSummaries, formatDateTime, scenarioName } from "../../domain/selectors";
import type { ImportedPackage } from "../../domain/types";
import { useAppState } from "../AppState";

interface PackageLibraryRow {
  id: string;
  name: string;
  importedAt: string;
  sourcePath: string;
  scenarios: string;
  tests: number;
  runs: number;
  targetTps: string;
  versions: string;
  saturatedRuns: number;
  package: ImportedPackage;
}

function toPackageLibraryRow(pkg: ImportedPackage): PackageLibraryRow {
  const summaries = buildRunSummaries(pkg);
  const scenarios = [...new Set(pkg.tests.map((test) => scenarioName(pkg, test.scenario_id)))].join(", ");
  const tpsValues = pkg.runs.map((run) => run.target_tps);
  const versions = [...new Set(pkg.configs.map((config) => config.exagon_ver))].join(", ");
  const saturatedRuns = summaries.filter((summary) => summary.saturation.saturated).length;

  return {
    id: pkg.id,
    name: pkg.name,
    importedAt: pkg.importedAt,
    sourcePath: pkg.sourcePath ?? "-",
    scenarios,
    tests: pkg.tests.length,
    runs: pkg.runs.length,
    targetTps: `${Math.min(...tpsValues)}-${Math.max(...tpsValues)}`,
    versions,
    saturatedRuns,
    package: pkg
  };
}

export function PackageLibraryPage() {
  const { activePackageId, deleteImportedPackage, packages, selectPackage, setView } = useAppState();
  const [scenarioFilter, setScenarioFilter] = useState("all");
  const [saturationFilter, setSaturationFilter] = useState("all");
  const [deletingPackageId, setDeletingPackageId] = useState<string>();
  const [deleteError, setDeleteError] = useState<string>();

  const scenarios = useMemo(
    () => ["all", ...new Set(packages.flatMap((pkg) => pkg.scenarios.map((scenario) => scenario.name)))],
    [packages]
  );

  const rows = useMemo(() => {
    return packages
      .map(toPackageLibraryRow)
      .filter((row) => scenarioFilter === "all" || row.scenarios.includes(scenarioFilter))
      .filter((row) => {
        if (saturationFilter === "saturated") return row.saturatedRuns > 0;
        if (saturationFilter === "clean") return row.saturatedRuns === 0;
        return true;
      });
  }, [packages, saturationFilter, scenarioFilter]);

  async function handleDeletePackage(row: PackageLibraryRow) {
    const confirmed = window.confirm(`Delete "${row.name}" from the library? This cannot be undone.`);
    if (!confirmed) return;

    setDeletingPackageId(row.id);
    setDeleteError(undefined);
    try {
      await deleteImportedPackage(row.id);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "The package could not be deleted.");
    } finally {
      setDeletingPackageId(undefined);
    }
  }

  const columns: ColumnDef<PackageLibraryRow>[] = [
    {
      header: "Package",
      accessorKey: "name",
      cell: ({ row }) => {
        const isActive = row.original.id === activePackageId;

        return (
          <div className="library-package-cell">
            <span>{row.original.name}</span>
            {isActive ? (
              <StatusPill tone="info">
                <CheckCircle2 size={13} aria-hidden="true" />
                Active
              </StatusPill>
            ) : null}
          </div>
        );
      }
    },
    { header: "Scenarios", accessorKey: "scenarios" },
    { header: "Tests", accessorKey: "tests" },
    { header: "Runs", accessorKey: "runs" },
    { header: "Target TPS", accessorKey: "targetTps" },
    { header: "Versions", accessorKey: "versions" },
    {
      header: "Saturation",
      cell: ({ row }) =>
        row.original.saturatedRuns > 0 ? (
          <StatusPill tone="warn">{row.original.saturatedRuns} saturated</StatusPill>
        ) : (
          <StatusPill tone="ok">clean</StatusPill>
        )
    },
    {
      header: "Imported",
      cell: ({ row }) => formatDateTime(row.original.importedAt)
    },
    {
      header: "",
      id: "action",
      cell: ({ row }) => (
        <span className="library-actions">
          <button
            className="button button-small"
            type="button"
            onClick={() => selectPackage(row.original.id)}
            disabled={row.original.id === activePackageId}
          >
            {row.original.id === activePackageId ? "Active" : "Open"}
          </button>
          <button
            className="button button-small button-danger"
            type="button"
            title={`Delete ${row.original.name}`}
            aria-label={`Delete ${row.original.name}`}
            onClick={() => handleDeletePackage(row.original)}
            disabled={deletingPackageId === row.original.id}
          >
            {deletingPackageId === row.original.id ? <Loader2 className="spin" size={15} /> : <Trash2 size={15} />}
          </button>
        </span>
      ),
      meta: { hideSortMarker: true }
    }
  ];

  return (
    <div className="page-stack">
      <header className="page-header">
        <div>
          <p className="eyebrow">Package Library</p>
          <h1>Imported test packages</h1>
        </div>
        <button className="button button-primary" type="button" onClick={() => setView("package-import")}>
          Package Import
        </button>
      </header>

      <section className="panel filter-row">
        <SlidersHorizontal size={18} />
        <label>
          Scenario
          <select value={scenarioFilter} onChange={(event) => setScenarioFilter(event.target.value)}>
            {scenarios.map((scenario) => (
              <option key={scenario} value={scenario}>
                {scenario}
              </option>
            ))}
          </select>
        </label>
        <label>
          Saturation
          <select value={saturationFilter} onChange={(event) => setSaturationFilter(event.target.value)}>
            <option value="all">all</option>
            <option value="saturated">saturated</option>
            <option value="clean">clean</option>
          </select>
        </label>
      </section>

      <section className="panel">
        <DataTable
          data={rows}
          columns={columns}
          searchPlaceholder="Search packages, versions, scenarios"
          emptyLabel="No imported packages"
        />
      </section>

      {deleteError ? (
        <section className="panel save-error-panel">
          <Trash2 size={20} />
          <div>
            <h2>Package was not deleted</h2>
            <p>{deleteError}</p>
          </div>
        </section>
      ) : null}
    </div>
  );
}

