import type { ColumnDef } from "@tanstack/react-table";
import { GitCompare } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { DataTable } from "../../components/DataTable";
import { StatusPill } from "../../components/StatusPill";
import { buildCpuRegressionRows, type CpuRegressionRow } from "../../domain/regression";
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

export function RegressionPage() {
  const { activePackage, setComparisonTestKeys, setView } = useAppState();
  const [selectedTestKeys, setSelectedTestKeys] = useState<string[]>([]);
  const rows = useMemo(() => (activePackage ? buildCpuRegressionRows(activePackage) : []), [activePackage]);

  useEffect(() => {
    setSelectedTestKeys([]);
  }, [activePackage?.id]);

  if (!activePackage) {
    return (
      <div className="empty-page">
        <h1>No package selected</h1>
        <button className="button button-primary" type="button" onClick={() => setView("import")}>
          Import package
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
    setView("comparisons");
  }

  const columns: ColumnDef<CpuRegressionRow>[] = [
    {
      id: "selection",
      header: () => (
        <input
          aria-label="Select all regression rows"
          checked={rows.length > 0 && selectedTestKeys.length === rows.length}
          type="checkbox"
          onChange={toggleAllRows}
        />
      ),
      cell: ({ row }) => (
        <input
          aria-label={`Select ${row.original.testKey}`}
          checked={selectedSet.has(row.original.testKey)}
          type="checkbox"
          onChange={() => toggleRow(row.original.testKey)}
        />
      ),
      enableSorting: false
    },
    { id: "scenario", header: "Scenario", accessorKey: "scenario" },
    { id: "sequenceId", header: "Sequence ID", accessorKey: "sequenceId" },
    { id: "exagonVersion", header: "Exagon_ver", accessorKey: "exagonVersion" },
    { id: "configId", header: "Config ID", accessorKey: "configId" },
    {
      id: "idle",
      header: "Base CPU (idle)",
      cell: ({ row }) => formatFixed(row.original.idle, 2)
    },
    {
      id: "marginalCpu",
      header: "Marginal CPU (L)",
      cell: ({ row }) => formatFixed(row.original.marginalCpu, 4)
    },
    {
      id: "transientOverhead",
      header: "Transient overhead (extra)",
      cell: ({ row }) => formatFixed(row.original.transientOverhead, 2)
    },
    {
      id: "halfSaturationK",
      header: "Overhead half-saturation const. (k)",
      cell: ({ row }) => formatFixed(row.original.halfSaturationK, 2)
    },
    {
      id: "rSquared",
      header: "R2",
      cell: ({ row }) => (row.original.rSquared === null ? "-" : formatFixed(row.original.rSquared, 4))
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
          <p className="eyebrow">Regression</p>
          <h1>CPU over TPS</h1>
          <span className="header-meta">{activePackage.name}</span>
        </div>
        <div className="header-actions">
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
          searchPlaceholder="Search regression rows"
          emptyLabel="No regression rows"
          initialSorting={[{ id: "scenario", desc: false }]}
        />
      </section>
    </div>
  );
}
