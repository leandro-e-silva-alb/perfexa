import type { ColumnDef } from "@tanstack/react-table";
import { useMemo } from "react";
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
  const { activePackage, setView } = useAppState();
  const rows = useMemo(() => (activePackage ? buildCpuRegressionRows(activePackage) : []), [activePackage]);

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

  const columns: ColumnDef<CpuRegressionRow>[] = [
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
        <StatusPill tone={fittedRows.length > 0 ? "ok" : "warn"}>
          {fittedRows.length} of {rows.length} fitted
        </StatusPill>
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
