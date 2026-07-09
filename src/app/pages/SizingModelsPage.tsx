import type { ColumnDef } from "@tanstack/react-table";
import { CircleHelp, GitCompare } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { DataTable } from "../../components/DataTable";
import { HelpModal } from "../../components/HelpModal";
import { StatusPill } from "../../components/StatusPill";
import { buildCpuSizingModelRows, type CpuSizingModelRow } from "../../domain/sizingModels";
import { useAppState } from "../AppState";

function formatFixed(value: number | null, digits: number): string {
  if (value === null || Number.isNaN(value)) {
    return "-";
  }

  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  }).format(value);
}

function average(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function nullableNumberSort<TData>(
  left: { original: TData },
  right: { original: TData },
  columnId: string
): number {
  const leftValue = (left.original as Record<string, number | null>)[columnId];
  const rightValue = (right.original as Record<string, number | null>)[columnId];

  if (leftValue === null && rightValue === null) {
    return 0;
  }

  if (leftValue === null) {
    return 1;
  }

  if (rightValue === null) {
    return -1;
  }

  return leftValue - rightValue;
}

export function SizingModelsPage() {
  const { activePackage, setComparisonTestKeys, setView } = useAppState();
  const [selectedTestKeys, setSelectedTestKeys] = useState<string[]>([]);
  const [helpOpen, setHelpOpen] = useState(false);
  const rows = useMemo(() => (activePackage ? buildCpuSizingModelRows(activePackage) : []), [activePackage]);

  useEffect(() => {
    setSelectedTestKeys([]);
  }, [activePackage?.id]);

  if (!activePackage) {
    return (
      <div className="empty-page">
        <h1>No package selected</h1>
        <button className="button button-primary" type="button" onClick={() => setView("package-import")}>
          Package Import
        </button>
      </div>
    );
  }

  const fittedRows = rows.filter((row) => row.rSquared !== null);
  const fittedPoints = rows.reduce((sum, row) => sum + row.fittedPoints, 0);
  const totalPoints = rows.reduce((sum, row) => sum + row.totalPoints, 0);
  const averageR2 = average(fittedRows.map((row) => row.rSquared).filter((value): value is number => value !== null));
  const selectedSet = new Set(selectedTestKeys);

  function toggleRow(testKey: string) {
    setSelectedTestKeys((current) =>
      current.includes(testKey) ? current.filter((key) => key !== testKey) : [...current, testKey]
    );
  }

  function toggleAllRows() {
    setSelectedTestKeys((current) => (current.length === rows.length ? [] : rows.map((row) => row.testKey)));
  }

  function compareSelectedRows() {
    setComparisonTestKeys(selectedTestKeys);
    setView("test-compare");
  }

  const columns: ColumnDef<CpuSizingModelRow>[] = [
    {
      id: "selection",
      header: () => (
        <label className="sizing-models-select-cell">
          <input
            aria-label="Select all sizing model rows"
            checked={rows.length > 0 && selectedTestKeys.length === rows.length}
            type="checkbox"
            onChange={toggleAllRows}
          />
        </label>
      ),
      cell: ({ row }) => (
        <label className="sizing-models-select-cell">
          <input
            aria-label={`Select ${row.original.testKey}`}
            checked={selectedSet.has(row.original.testKey)}
            type="checkbox"
            onChange={() => toggleRow(row.original.testKey)}
          />
        </label>
      ),
      enableSorting: false,
      meta: { hideSortMarker: true }
    },
    { id: "scenario", header: "Scenario", accessorKey: "scenario" },
    { id: "exagonVersion", header: "Exagon version", accessorKey: "exagonVersion" },
    { id: "sequenceId", header: "SN", accessorKey: "sequenceId" },
    {
      id: "idle",
      header: "Base CPU (idle)",
      accessorKey: "idle",
      sortingFn: nullableNumberSort,
      cell: ({ row }) => formatFixed(row.original.idle, 2)
    },
    {
      id: "marginalCpu",
      header: "Incremental CPU (L)",
      accessorKey: "marginalCpu",
      sortingFn: nullableNumberSort,
      cell: ({ row }) => formatFixed(row.original.marginalCpu, 4)
    },
    {
      id: "transientOverhead",
      header: "Transient CPU overhead (extra)",
      accessorKey: "transientOverhead",
      sortingFn: nullableNumberSort,
      cell: ({ row }) => formatFixed(row.original.transientOverhead, 2)
    },
    {
      id: "halfSaturationK",
      header: "Overhead half-saturation const. (k)",
      accessorKey: "halfSaturationK",
      sortingFn: nullableNumberSort,
      cell: ({ row }) => formatFixed(row.original.halfSaturationK, 2)
    },
    {
      id: "rSquared",
      header: "R2",
      accessorKey: "rSquared",
      sortingFn: nullableNumberSort,
      cell: ({ row }) => (row.original.rSquared === null ? "-" : formatFixed(row.original.rSquared, 4))
    },
    {
      id: "rmse",
      header: "RMSE",
      accessorKey: "rmse",
      sortingFn: nullableNumberSort,
      cell: ({ row }) => formatFixed(row.original.rmse, 2)
    },
    {
      id: "points",
      header: "Points Fitted/Total",
      cell: ({ row }) => `${row.original.fittedPoints}/${row.original.totalPoints}`
    }
  ];
  return (
    <div className="page-stack page-stack-wide">
      <header className="page-header">
        <div>
          <p className="eyebrow">Sizing Models</p>
          <h1>CPU over TPS</h1>
          <span className="header-meta">{activePackage.name}</span>
        </div>
        <div className="header-actions">
          <button
            className="button"
            type="button"
            onClick={() => setHelpOpen((open) => !open)}
            aria-expanded={helpOpen}
            aria-controls="sizing-models-help"
            title="Show sizing model help"
          >
            <CircleHelp size={16} aria-hidden="true" />
            Help
          </button>
          <button
            className="button"
            type="button"
            onClick={compareSelectedRows}
            disabled={selectedTestKeys.length === 0}
          >
            <GitCompare size={16} aria-hidden="true" />
            Compare selected
          </button>
          <StatusPill tone={fittedRows.length > 0 ? "ok" : "warn"}>
            {fittedRows.length} of {rows.length} fitted
          </StatusPill>
        </div>
      </header>

      <section className="metric-strip">
        <div className="metric-tile">
          <span>Tests</span>
          <strong>{rows.length}</strong>
        </div>
        <div className="metric-tile">
          <span>Fitted points</span>
          <strong>{fittedPoints}</strong>
        </div>
        <div className="metric-tile">
          <span>Excluded points</span>
          <strong>{totalPoints - fittedPoints}</strong>
        </div>
        <div className="metric-tile">
          <span>Average R2</span>
          <strong>{formatFixed(averageR2, 4)}</strong>
        </div>
      </section>

      <section className="panel">
        <DataTable
          data={rows}
          columns={columns}
          searchPlaceholder="Search sizing model rows"
          emptyLabel="No sizing model rows"
          initialSorting={[{ id: "scenario", desc: false }]}
        />
      </section>
      <HelpModal
        open={helpOpen}
        title="Sizing model help"
        id="sizing-models-help"
        className="sizing-models-help-modal"
        contentClassName="sizing-models-help-content"
        closeLabel="Close sizing model help"
        onClose={() => setHelpOpen(false)}
      >
        <img src="/sizing-models-cpu-model.png" alt="Decomposicao do modelo CPU por TPS" />
      </HelpModal>
    </div>
  );
}

