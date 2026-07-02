import type { ColumnDef } from "@tanstack/react-table";
import EChartsReact from "echarts-for-react";
import { useEffect, useMemo, useState } from "react";
import { DataTable } from "../../components/DataTable";
import { StatusPill } from "../../components/StatusPill";
import {
  formatNumber,
  metricUnit,
  measurementsForScope,
  testKeyFor,
  testNameFor,
  type MetricPoint
} from "../../domain/selectors";
import type { ImportedPackage } from "../../domain/types";
import { useAppState } from "../AppState";

type Scope = "run" | "pod" | "group";
type ChartMode = "line" | "stackedArea";
type ChartDatum = [number, number, string];
type StackedAreaDatum = { value: number; runIds: string };
type TooltipParam = {
  seriesName: string;
  marker?: string;
  data: ChartDatum | StackedAreaDatum | number;
  value?: ChartDatum | StackedAreaDatum | number;
  axisValue?: string | number;
  axisValueLabel?: string;
};
type AxisPointerLabelParam = { axisDimension?: string; value: string | number };
type LegendSelectChangedParam = { selected?: Record<string, boolean> };
type MetricConfig = {
  id: string;
  label: string;
  defaultStat: string;
  fallbackStats?: string[];
  scopes: Scope[];
};

const MAX_POD_TOOLTIP_ITEMS = 8;

function niceAxisMax(value: number): number | undefined {
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const niceNormalized = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return niceNormalized * magnitude;
}

function tooltipValue(param: TooltipParam): number {
  if (Array.isArray(param.data)) return param.data[1];
  if (typeof param.data === "number") return param.data;
  return param.data.value;
}

function tooltipRunIds(param: TooltipParam): string {
  if (Array.isArray(param.data)) return param.data[2];
  if (typeof param.data === "number") return "";
  return param.data.runIds;
}

function availableStatsForMetric(
  pkg: ImportedPackage | null | undefined,
  selectedRunIds: ReadonlySet<string>,
  metric: MetricConfig
): string[] {
  if (!pkg) return [metric.defaultStat];
  const stats = [
    ...new Set(
      pkg.measurements
        .filter((measurement) => selectedRunIds.has(measurement.run_id))
        .filter((measurement) => measurement.metric_id === metric.id)
        .map((item) => item.stat)
    )
  ];
  const preferredStats = [metric.defaultStat, ...(metric.fallbackStats ?? [])];
  return [
    ...preferredStats.filter((item) => stats.includes(item)),
    ...stats.filter((item) => !preferredStats.includes(item)).sort()
  ];
}

const metricConfigs: MetricConfig[] = [
  { id: "latency", label: "Latency", defaultStat: "p95", fallbackStats: ["avg"], scopes: ["run"] },
  { id: "error_rate", label: "Errors", defaultStat: "avg", scopes: ["run"] },
  { id: "cpu", label: "CPU", defaultStat: "avg", scopes: ["pod", "group"] },
  { id: "memory", label: "Memory", defaultStat: "avg", scopes: ["pod", "group"] },
  { id: "throttling", label: "Throttling", defaultStat: "max", scopes: ["pod", "group"] }
];

export function MetricsExplorerPage() {
  const { activePackage, setView } = useAppState();
  const [metricId, setMetricId] = useState("latency");
  const config = metricConfigs.find((item) => item.id === metricId) ?? metricConfigs[0];
  const [stat, setStat] = useState(config.defaultStat);
  const [scope, setScope] = useState<Scope>(config.scopes[0]);
  const [selectedTestKey, setSelectedTestKey] = useState("");
  const [chartMode, setChartMode] = useState<ChartMode>("line");
  const [legendSelected, setLegendSelected] = useState<Record<string, boolean>>({});

  const testOptions = useMemo(() => {
    if (!activePackage) return [];
    return activePackage.tests
      .map((test) => ({
        key: testKeyFor(test),
        label: testNameFor(activePackage, test)
      }))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  }, [activePackage]);

  useEffect(() => {
    setSelectedTestKey((current) =>
      current && testOptions.some((test) => test.key === current) ? current : testOptions[0]?.key ?? ""
    );
  }, [testOptions]);

  const selectedRunIds = useMemo(() => {
    if (!activePackage || !selectedTestKey) return new Set<string>();
    return new Set(
      activePackage.runs
        .filter((run) => testKeyFor(run) === selectedTestKey)
        .map((run) => run.run_id)
    );
  }, [activePackage, selectedTestKey]);

  const availableStats = useMemo(() => {
    return availableStatsForMetric(activePackage, selectedRunIds, config);
  }, [activePackage, config, selectedRunIds]);

  useEffect(() => {
    if (!availableStats.includes(stat)) {
      setStat(availableStats[0] ?? config.defaultStat);
    }
  }, [availableStats, config.defaultStat, stat]);

  useEffect(() => {
    setLegendSelected({});
  }, [metricId, scope, selectedTestKey, stat]);

  const scopeOptions = useMemo(() => {
    if (!activePackage) return config.scopes;
    return config.scopes.filter(
      (item) => item !== "group" || Object.keys(activePackage.topology.groups).length > 0
    );
  }, [activePackage, config.scopes]);

  const rows = useMemo(() => {
    if (!activePackage || !selectedTestKey) return [];
    return measurementsForScope(activePackage, metricId, stat, scope).filter(
      (row) => row.test_key === selectedTestKey
    );
  }, [activePackage, metricId, scope, selectedTestKey, stat]);

  const isAdditiveMetric = ["cpu", "memory"].includes(metricId);
  const canUseStackedArea = isAdditiveMetric && scope !== "run";
  const effectiveChartMode = canUseStackedArea ? chartMode : "line";

  useEffect(() => {
    if (!canUseStackedArea && chartMode !== "line") {
      setChartMode("line");
    }
  }, [canUseStackedArea, chartMode]);

  const selectMetric = (metric: MetricConfig) => {
    const nextStats = availableStatsForMetric(activePackage, selectedRunIds, metric);
    setMetricId(metric.id);
    setStat(nextStats[0] ?? metric.defaultStat);
    setScope(metric.scopes[0]);
    setLegendSelected({});
    if (!["cpu", "memory"].includes(metric.id)) {
      setChartMode("line");
    }
  };

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

  const unit = metricUnit(activePackage, metricId);
  const selectedTestLabel = testOptions.find((test) => test.key === selectedTestKey)?.label ?? "No test selected";
  const seriesNames = [...new Set(rows.map((row) => row.instance_id || row.instance_type))].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true })
  );
  const normalizedLegendSelected = Object.fromEntries(
    seriesNames.map((name) => [name, legendSelected[name] ?? true])
  );
  const visibleSeriesNames = seriesNames.filter((name) => normalizedLegendSelected[name]);
  const yAxisSeriesNames = visibleSeriesNames.length > 0 ? visibleSeriesNames : seriesNames;
  const effectiveTpsValues = [...new Set(rows.map((row) => row.effective_tps))].sort((a, b) => a - b);
  const firstEffectiveTps = effectiveTpsValues[0];
  const lastEffectiveTps = effectiveTpsValues[effectiveTpsValues.length - 1];
  const valuesBySeriesAndTps = rows.reduce((seriesMap, row) => {
    const seriesName = row.instance_id || row.instance_type;
    const tpsMap = seriesMap.get(seriesName) ?? new Map<number, { total: number; count: number; runIds: string[] }>();
    const bucket = tpsMap.get(row.effective_tps) ?? { total: 0, count: 0, runIds: [] };
    bucket.total += row.value;
    bucket.count += 1;
    bucket.runIds.push(row.run_id);
    tpsMap.set(row.effective_tps, bucket);
    seriesMap.set(seriesName, tpsMap);
    return seriesMap;
  }, new Map<string, Map<number, { total: number; count: number; runIds: string[] }>>());
  const stackedTotalsByTps = effectiveTpsValues.map((effectiveTps) =>
    yAxisSeriesNames.reduce((sum, name) => {
      const bucket = valuesBySeriesAndTps.get(name)?.get(effectiveTps);
      return sum + (bucket ? bucket.total / bucket.count : 0);
    }, 0)
  );
  const stackedYAxisMax = niceAxisMax(Math.max(0, ...stackedTotalsByTps) * 1.08);
  const chartSeries = seriesNames.map((name) => {
    const seriesRows = rows
      .filter((row) => (row.instance_id || row.instance_type) === name)
      .sort((a, b) => a.effective_tps - b.effective_tps || a.run_id.localeCompare(b.run_id));
    const data =
      effectiveChartMode === "stackedArea"
        ? effectiveTpsValues.map((effectiveTps): ChartDatum => {
            const bucket = valuesBySeriesAndTps.get(name)?.get(effectiveTps);
            return [
              effectiveTps,
              bucket ? bucket.total / bucket.count : 0,
              bucket?.runIds.join(", ") ?? ""
            ];
          })
        : seriesRows.map((row): ChartDatum => [row.effective_tps, row.value, row.run_id]);

    return {
      name,
      type: "line",
      dimensions: effectiveChartMode === "line" ? ["effective_tps", "value", "run_id"] : undefined,
      encode:
        effectiveChartMode === "line"
          ? { x: "effective_tps", y: "value", tooltip: ["effective_tps", "value", "run_id"] }
          : undefined,
      stack: effectiveChartMode === "stackedArea" ? "total" : undefined,
      areaStyle: effectiveChartMode === "stackedArea" ? { opacity: 0.86 } : undefined,
      emphasis: { focus: "series" },
      showSymbol: effectiveChartMode === "line",
      symbolSize: 7,
      data:
        effectiveChartMode === "stackedArea"
          ? data.map((item): StackedAreaDatum => ({ value: item[1], runIds: item[2] }))
          : data
    };
  });
  const formatTooltip = (params: TooltipParam | TooltipParam[]) => {
    const items = Array.isArray(params) ? params : [params];
    const tps =
      items[0]?.axisValueLabel ??
      items[0]?.axisValue ??
      (Array.isArray(items[0]?.data) ? items[0].data[0] : "-");
    const formatTooltipRows = (tooltipItems: TooltipParam[], includeTotal: boolean) => {
      const sortedItems = [...tooltipItems].sort((a, b) => tooltipValue(b) - tooltipValue(a));
      const isCompact = scope === "pod" && sortedItems.length > MAX_POD_TOOLTIP_ITEMS;
      const shownItems = isCompact ? sortedItems.slice(0, MAX_POD_TOOLTIP_ITEMS) : sortedItems;
      const hiddenItems = isCompact ? sortedItems.slice(MAX_POD_TOOLTIP_ITEMS) : [];
      const total = sortedItems.reduce((sum, item) => sum + tooltipValue(item), 0);
      const lines = shownItems.map(
        (item) => `${item.marker ?? ""}${item.seriesName}: ${formatNumber(tooltipValue(item), 2)} ${unit}`
      );

      if (hiddenItems.length > 0) {
        const hiddenTotal = hiddenItems.reduce((sum, item) => sum + tooltipValue(item), 0);
        lines.push(
          isAdditiveMetric
            ? `+${hiddenItems.length} more: ${formatNumber(hiddenTotal, 2)} ${unit}`
            : `+${hiddenItems.length} more smaller values`
        );
      }

      return includeTotal
        ? [`Effective TPS ${tps}`, `Total visible: ${formatNumber(total, 2)} ${unit}`, ...lines]
        : [`Effective TPS ${tps}`, ...lines];
    };

    if (effectiveChartMode === "stackedArea") {
      const visibleItems = items.filter((item) => item.data && tooltipValue(item) > 0);
      return formatTooltipRows(visibleItems, true).join("<br/>");
    }

    const lineItems = items.filter((item) => item.data);
    if (lineItems.length > 1) {
      const runIds = [...new Set(lineItems.map(tooltipRunIds).filter(Boolean))].join(", ");
      const lines = formatTooltipRows(lineItems, isAdditiveMetric);
      return [lines[0], runIds, ...lines.slice(1)].filter(Boolean).join("<br/>");
    }

    const item = items[0];
    const runIds = tooltipRunIds(item);
    return `${item.seriesName}<br/>Effective TPS ${tps}<br/>${formatNumber(tooltipValue(item), 2)} ${unit}<br/>${runIds}`;
  };
  const formatAxisPointerLabel = (params: AxisPointerLabelParam) => {
    if (params.axisDimension === "x") return `Effective TPS ${params.value}`;
    const numericValue = Number(params.value);
    return Number.isFinite(numericValue) ? `${formatNumber(numericValue, 2)} ${unit}` : String(params.value);
  };
  const handleLegendSelectChanged = (event: LegendSelectChangedParam) => {
    if (event.selected) {
      setLegendSelected(event.selected);
    }
  };
  const chartOption = {
    animation: true,
    animationDuration: 260,
    animationDurationUpdate: 420,
    animationEasing: "cubicOut",
    animationEasingUpdate: "cubicOut",
    tooltip: {
      trigger: "axis",
      confine: true,
      axisPointer: {
        type: "cross",
        snap: true,
        label: {
          backgroundColor: "#334155",
          formatter: formatAxisPointerLabel
        }
      },
      formatter: formatTooltip
    },
    legend: {
      type: "scroll",
      top: 0,
      selected: normalizedLegendSelected,
      textStyle: { color: "#3a424b" }
    },
    grid: { left: 14, right: 28, top: 64, bottom: 50, containLabel: true },
    xAxis:
      effectiveChartMode === "stackedArea"
        ? {
            type: "category",
            data: effectiveTpsValues,
            boundaryGap: false,
            name: "Effective TPS",
            nameLocation: "middle",
            nameGap: 28
          }
        : {
            type: "value",
            name: "Effective TPS",
            nameLocation: "middle",
            nameGap: 28,
            min: firstEffectiveTps,
            max: lastEffectiveTps
          },
    yAxis: {
      type: "value",
      name: unit,
      nameGap: 22,
      min: effectiveChartMode === "stackedArea" ? 0 : undefined,
      max: effectiveChartMode === "stackedArea" ? stackedYAxisMax : undefined
    },
    series: chartSeries
  };

  const columns: ColumnDef<MetricPoint>[] = [
    { header: "Run", accessorKey: "run_id" },
    { header: "Test", accessorKey: "test_name" },
    { header: "Scenario", accessorKey: "scenario_name" },
    { header: "Effective TPS", accessorKey: "effective_tps" },
    { header: "Metric", accessorKey: "metric_id" },
    { header: "Stat", accessorKey: "stat" },
    { header: "Scope", accessorKey: "instance_type" },
    { header: "Instance", accessorKey: "instance_id" },
    {
      header: "Value",
      cell: ({ row }) => `${formatNumber(row.original.value, 2)} ${row.original.unit}`
    }
  ];

  return (
    <div className="page-stack page-stack-wide">
      <header className="page-header">
        <div>
          <p className="eyebrow">Metrics</p>
          <h1>{config.label}</h1>
          <span className="header-meta">{selectedTestLabel}</span>
        </div>
        <StatusPill tone={rows.length > 0 ? "ok" : "warn"}>{rows.length} facts</StatusPill>
      </header>

      <section className="panel explorer-controls">
        <label>
          Test
          <select value={selectedTestKey} onChange={(event) => setSelectedTestKey(event.target.value)}>
            {testOptions.map((test) => (
              <option key={test.key} value={test.key}>
                {test.label}
              </option>
            ))}
          </select>
        </label>
        <div className="segmented">
          {metricConfigs.map((metric) => (
            <button
              key={metric.id}
              type="button"
              className={metric.id === metricId ? "selected" : ""}
              onClick={() => selectMetric(metric)}
            >
              {metric.label}
            </button>
          ))}
        </div>
        <label>
          Stat
          <select value={stat} onChange={(event) => setStat(event.target.value)}>
            {availableStats.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        <div className="segmented">
          {scopeOptions.map((item) => (
            <button
              key={item}
              type="button"
              className={item === scope ? "selected" : ""}
              onClick={() => setScope(item)}
            >
              {item}
            </button>
          ))}
        </div>
        {canUseStackedArea ? (
          <div className="chart-mode-control">
            <span>Chart</span>
            <div className="segmented" role="group" aria-label="Chart mode">
              <button
                type="button"
                className={effectiveChartMode === "line" ? "selected" : ""}
                onClick={() => setChartMode("line")}
              >
                lines
              </button>
              <button
                type="button"
                className={effectiveChartMode === "stackedArea" ? "selected" : ""}
                onClick={() => setChartMode("stackedArea")}
              >
                stacked area
              </button>
            </div>
          </div>
        ) : null}
      </section>

      <section className="panel chart-panel">
        <EChartsReact
          option={chartOption}
          onEvents={{ legendselectchanged: handleLegendSelectChanged }}
          notMerge
          style={{ height: 340, width: "100%" }}
        />
      </section>

      <section className="panel">
        <DataTable
          data={rows}
          columns={columns}
          searchPlaceholder="Search measurements"
          emptyLabel="No measurements for this selection"
          compact
        />
      </section>
    </div>
  );
}
