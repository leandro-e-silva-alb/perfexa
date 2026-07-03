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
import { buildTopologyGraph, type TopologyGraph } from "../../domain/topologyMetrics";
import type { ImportedPackage } from "../../domain/types";
import { useAppState } from "../AppState";

type Scope = string;
type ChartMode = "line" | "stackedArea";
type ChartDatum = [number, number, string];
type StackedAreaDatum = [number, number, string];
type TooltipParam = {
  seriesName: string;
  marker?: string;
  color?: string;
  data: ChartDatum | StackedAreaDatum | number;
  value?: ChartDatum | StackedAreaDatum | number;
  axisValue?: string | number;
  axisValueLabel?: string;
};
type AxisPointerLabelParam = { axisDimension?: string; value: string | number };
type LegendSelectChangedParam = { selected?: Record<string, boolean> };
type ChartMouseEventParam = {
  componentType?: string;
  seriesName?: string;
};
type MetricConfig = {
  id: string;
  label: string;
  defaultStat: string;
  fallbackStats?: string[];
  scopeType: "run" | "topology";
};

const MAX_TOPOLOGY_TOOLTIP_ITEMS = 8;

function niceAxisMax(value: number): number | undefined {
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const targetTicks = 5;
  const rawStep = value / targetTicks;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalizedStep = rawStep / magnitude;
  const niceSteps = [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
  const niceStep = (niceSteps.find((step) => normalizedStep <= step) ?? 10) * magnitude;
  return Math.ceil(value / niceStep) * niceStep;
}

function tooltipValue(param: TooltipParam, mode: ChartMode): number {
  if (Array.isArray(param.data)) return mode === "stackedArea" ? param.data[0] : param.data[1];
  if (typeof param.data === "number") return param.data;
  return 0;
}

function tooltipRunIds(param: TooltipParam): string {
  if (Array.isArray(param.data)) return param.data[2];
  if (typeof param.data === "number") return "";
  return "";
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    };
    return entities[character];
  });
}

function safeCssColor(value: string | undefined): string {
  if (!value) return "#64748b";
  return value.replace(/[;"'<>]/g, "");
}

function normalizeChartSymbol(symbol: string | undefined): "circle" | "square" | "triangle" | "diamond" {
  switch (symbol?.trim().toLowerCase()) {
    case "rect":
    case "square":
      return "square";
    case "triangle":
      return "triangle";
    case "diamond":
      return "diamond";
    case "circle":
    default:
      return "circle";
  }
}

function emptyChartSymbol(symbol: string | undefined): string {
  switch (normalizeChartSymbol(symbol)) {
    case "square":
      return "emptyRect";
    case "triangle":
      return "emptyTriangle";
    case "diamond":
      return "emptyDiamond";
    case "circle":
    default:
      return "emptyCircle";
  }
}

function tooltipShapeSvg(symbol: string | undefined, color: string): string {
  const shapeStyle = `fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"`;

  switch (normalizeChartSymbol(symbol)) {
    case "square":
      return `<rect x="2.5" y="2.5" width="7" height="7" rx="1.2" ${shapeStyle} />`;
    case "triangle":
      return `<path d="M6 2.1 L10 9.4 H2 Z" ${shapeStyle} />`;
    case "diamond":
      return `<path d="M6 1.8 L10.2 6 L6 10.2 L1.8 6 Z" ${shapeStyle} />`;
    case "circle":
    default:
      return `<circle cx="6" cy="6" r="4" ${shapeStyle} />`;
  }
}

function sameTooltipSeries(left: TooltipParam, right: TooltipParam): boolean {
  return left.seriesName === right.seriesName;
}

function orderSeriesNames(names: string[], graph: TopologyGraph | null, scope: string): string[] {
  const fallback = [...names].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!graph) return fallback;

  const targetLevelIndex = graph.levels.indexOf(scope);
  if (targetLevelIndex < 0) return fallback;

  const remaining = new Set(names);
  const ordered: string[] = [];
  const visitNode = (nodeId: string) => {
    const node = graph.nodes.get(nodeId);
    if (!node) return;

    if (remaining.delete(node.id)) {
      ordered.push(node.id);
    }

    if (node.levelIndex >= targetLevelIndex) {
      return;
    }

    for (const childId of node.children) {
      visitNode(childId);
    }
  };

  for (const rootId of graph.roots) {
    visitNode(rootId);
  }

  return [...ordered, ...fallback.filter((name) => remaining.has(name))];
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
  { id: "latency", label: "Latency", defaultStat: "p95", fallbackStats: ["avg"], scopeType: "run" },
  { id: "error_rate", label: "Errors", defaultStat: "avg", scopeType: "run" },
  { id: "cpu", label: "CPU", defaultStat: "avg", scopeType: "topology" },
  { id: "memory", label: "Memory", defaultStat: "avg", scopeType: "topology" },
  { id: "throttling", label: "Throttling", defaultStat: "max", scopeType: "topology" }
];

function scopeOptionsForMetric(metric: MetricConfig, pkg: ImportedPackage | null | undefined): string[] {
  if (metric.scopeType === "run") {
    return ["run"];
  }

  return pkg ? buildTopologyGraph(pkg.topology).levels : [];
}

export function MetricsExplorerPage() {
  const { activePackage, setView } = useAppState();
  const [metricId, setMetricId] = useState("latency");
  const config = metricConfigs.find((item) => item.id === metricId) ?? metricConfigs[0];
  const [stat, setStat] = useState(config.defaultStat);
  const [scope, setScope] = useState<Scope>("run");
  const [selectedTestKey, setSelectedTestKey] = useState("");
  const [chartMode, setChartMode] = useState<ChartMode>("line");
  const [legendSelected, setLegendSelected] = useState<Record<string, boolean>>({});
  const [highlightedSeriesName, setHighlightedSeriesName] = useState<string | null>(null);

  const testOptions = useMemo(() => {
    if (!activePackage) return [];
    return activePackage.tests
      .map((test) => ({
        key: testKeyFor(test),
        label: testNameFor(activePackage, test)
      }))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  }, [activePackage]);
  const topologyGraph = useMemo(() => {
    return activePackage ? buildTopologyGraph(activePackage.topology) : null;
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
    setHighlightedSeriesName(null);
  }, [chartMode, metricId, scope, selectedTestKey, stat]);

  const scopeOptions = useMemo(() => {
    return scopeOptionsForMetric(config, activePackage);
  }, [activePackage, config]);

  useEffect(() => {
    if (!scopeOptions.includes(scope)) {
      setScope(scopeOptions[0] ?? "run");
    }
  }, [scope, scopeOptions]);

  const rows = useMemo(() => {
    if (!activePackage || !selectedTestKey) return [];
    return measurementsForScope(activePackage, metricId, stat, scope, selectedTestKey).filter(
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
    const nextScopes = scopeOptionsForMetric(metric, activePackage);
    setMetricId(metric.id);
    setStat(nextStats[0] ?? metric.defaultStat);
    setScope(nextScopes[0] ?? "run");
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
  const seriesNames = orderSeriesNames(
    [...new Set(rows.map((row) => row.instance_id || row.scope))],
    topologyGraph,
    scope
  );
  const normalizedLegendSelected = Object.fromEntries(
    seriesNames.map((name) => [name, legendSelected[name] ?? true])
  );
  const seriesOrder = new Map(seriesNames.map((name, index) => [name, index]));
  const visibleSeriesNames = seriesNames.filter((name) => normalizedLegendSelected[name]);
  const yAxisSeriesNames = visibleSeriesNames.length > 0 ? visibleSeriesNames : seriesNames;
  const effectiveTpsValues = [...new Set(rows.map((row) => row.effective_tps))].sort((a, b) => a - b);
  const lastEffectiveTps = effectiveTpsValues[effectiveTpsValues.length - 1];
  const valuesBySeriesAndTps = rows.reduce((seriesMap, row) => {
    const seriesName = row.instance_id || row.scope;
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
      .filter((row) => (row.instance_id || row.scope) === name)
      .sort((a, b) => a.effective_tps - b.effective_tps || a.run_id.localeCompare(b.run_id));
    const isDerivedSeries = seriesRows.length > 0 && seriesRows.every((row) => row.source === "derived");
    const topologyNode = topologyGraph?.nodes.get(name);
    const seriesColor = topologyNode?.color;
    const isDimmedByHighlight = Boolean(highlightedSeriesName && highlightedSeriesName !== name);
    const lineOpacity = isDimmedByHighlight ? 0.2 : 1;
    const areaOpacity = isDimmedByHighlight ? 0.14 : 0.86;
    const pointOpacity = isDimmedByHighlight ? 0.28 : 1;
    const lineStyle = {
      opacity: lineOpacity,
      ...(isDerivedSeries ? { type: "dashed" } : {}),
      ...(seriesColor ? { color: seriesColor } : {})
    };
    const areaStyle = {
      opacity: areaOpacity,
      ...(seriesColor ? { color: seriesColor } : {})
    };
    const itemStyle = {
      opacity: pointOpacity,
      borderWidth: 2,
      ...(seriesColor ? { borderColor: seriesColor } : {})
    };
    const emphasis = {
      itemStyle: {
        opacity: pointOpacity,
        borderWidth: 3,
        ...(seriesColor ? { borderColor: seriesColor } : {})
      },
      lineStyle: {
        opacity: lineOpacity,
        ...(seriesColor ? { color: seriesColor } : {})
      },
      areaStyle:
        effectiveChartMode === "stackedArea"
          ? {
              opacity: areaOpacity,
              ...(seriesColor ? { color: seriesColor } : {})
            }
          : undefined
    };
    const data =
      effectiveChartMode === "stackedArea"
        ? effectiveTpsValues.map((effectiveTps): StackedAreaDatum => {
            const bucket = valuesBySeriesAndTps.get(name)?.get(effectiveTps);
            return [
              bucket ? bucket.total / bucket.count : 0,
              effectiveTps,
              bucket?.runIds.join(", ") ?? ""
            ];
          })
        : seriesRows.map((row): ChartDatum => [row.effective_tps, row.value, row.run_id]);

    return {
      name,
      type: "line",
      color: seriesColor,
      dimensions:
        effectiveChartMode === "stackedArea"
          ? ["value", "effective_tps", "run_id"]
          : ["effective_tps", "value", "run_id"],
      encode:
        { x: "effective_tps", y: "value", tooltip: ["effective_tps", "value", "run_id"] },
      stack: effectiveChartMode === "stackedArea" ? "total" : undefined,
      areaStyle: effectiveChartMode === "stackedArea" ? areaStyle : undefined,
      lineStyle: Object.keys(lineStyle).length > 0 ? lineStyle : undefined,
      itemStyle,
      emphasis,
      triggerLineEvent: true,
      showSymbol: true,
      showAllSymbol: true,
      symbol: emptyChartSymbol(topologyNode?.symbol),
      symbolSize: 8,
      data
    };
  });
  const tooltipMarker = (param: TooltipParam): string => {
    const topologyNode = topologyGraph?.nodes.get(param.seriesName);
    const color = safeCssColor(topologyNode?.color ?? (typeof param.color === "string" ? param.color : undefined));
    return [
      '<span style="display:inline-flex;width:14px;height:14px;margin-right:6px;vertical-align:-2px;align-items:center;justify-content:center;">',
      `<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">`,
      tooltipShapeSvg(topologyNode?.symbol, color),
      "</svg>",
      "</span>"
    ].join("");
  };
  const tooltipRow = (item: TooltipParam): string => {
    const isHighlighted = item.seriesName === highlightedSeriesName;
    const isDimmed = Boolean(highlightedSeriesName && !isHighlighted);
    const style = [
      "display:inline-block",
      `opacity:${isDimmed ? "0.35" : "1"}`,
      `font-weight:${isHighlighted ? "700" : "400"}`
    ].join(";");

    return `<span style="${style}">${tooltipMarker(item)}${escapeHtml(item.seriesName)}: ${formatNumber(
      tooltipValue(item, effectiveChartMode),
      2
    )} ${unit}</span>`;
  };
  const hiddenTooltipRow = (hiddenItems: TooltipParam[]): string => {
    const hiddenTotal = hiddenItems.reduce((sum, item) => sum + tooltipValue(item, effectiveChartMode), 0);
    const label = isAdditiveMetric
      ? `+${hiddenItems.length} more: ${formatNumber(hiddenTotal, 2)} ${unit}`
      : `+${hiddenItems.length} more smaller values`;
    const style = [
      "display:inline-block",
      `opacity:${highlightedSeriesName ? "0.35" : "1"}`,
      "font-weight:400"
    ].join(";");

    return `<span style="${style}">${escapeHtml(label)}</span>`;
  };
  const formatTooltip = (params: TooltipParam | TooltipParam[]) => {
    const items = Array.isArray(params) ? params : [params];
    const tps =
      items[0]?.axisValueLabel ??
      items[0]?.axisValue ??
      (Array.isArray(items[0]?.data)
        ? effectiveChartMode === "stackedArea"
          ? items[0].data[1]
          : items[0].data[0]
        : "-");
    const formatTooltipRows = (tooltipItems: TooltipParam[], includeTotal: boolean) => {
      const sortedItems = [...tooltipItems].sort((a, b) => {
        if (effectiveChartMode === "stackedArea") {
          return (seriesOrder.get(a.seriesName) ?? Number.MAX_SAFE_INTEGER) -
            (seriesOrder.get(b.seriesName) ?? Number.MAX_SAFE_INTEGER);
        }
        return tooltipValue(b, effectiveChartMode) - tooltipValue(a, effectiveChartMode);
      });
      const isCompact = config.scopeType === "topology" && sortedItems.length > MAX_TOPOLOGY_TOOLTIP_ITEMS;
      const highlightedItem = highlightedSeriesName
        ? sortedItems.find((item) => item.seriesName === highlightedSeriesName)
        : undefined;
      const shownItems = isCompact ? sortedItems.slice(0, MAX_TOPOLOGY_TOOLTIP_ITEMS) : sortedItems;
      const hiddenItems = isCompact ? sortedItems.slice(MAX_TOPOLOGY_TOOLTIP_ITEMS) : [];
      const highlightedItemIsHidden = Boolean(
        highlightedItem && hiddenItems.some((item) => sameTooltipSeries(item, highlightedItem))
      );
      const visibleItems = highlightedItemIsHidden ? [...shownItems, highlightedItem as TooltipParam] : shownItems;
      const collapsedItems = highlightedItemIsHidden
        ? hiddenItems.filter((item) => !sameTooltipSeries(item, highlightedItem as TooltipParam))
        : hiddenItems;
      const total = sortedItems.reduce((sum, item) => sum + tooltipValue(item, effectiveChartMode), 0);
      const lines = visibleItems.map(tooltipRow);

      if (collapsedItems.length > 0) {
        lines.push(hiddenTooltipRow(collapsedItems));
      }

      return includeTotal
        ? [`Effective TPS ${tps}`, `Total visible: ${formatNumber(total, 2)} ${unit}`, ...lines]
        : [`Effective TPS ${tps}`, ...lines];
    };

    if (effectiveChartMode === "stackedArea") {
      const visibleItems = items.filter((item) => item.data && tooltipValue(item, effectiveChartMode) > 0);
      return formatTooltipRows(visibleItems, true).join("<br/>");
    }

    const lineItems = items.filter((item) => item.data);
    if (lineItems.length > 1) {
      const runIds = escapeHtml([...new Set(lineItems.map(tooltipRunIds).filter(Boolean))].join(", "));
      const lines = formatTooltipRows(lineItems, isAdditiveMetric);
      return [lines[0], runIds, ...lines.slice(1)].filter(Boolean).join("<br/>");
    }

    const item = items[0];
    const runIds = escapeHtml(tooltipRunIds(item));
    return `${tooltipMarker(item)}${escapeHtml(item.seriesName)}<br/>Effective TPS ${tps}<br/>${formatNumber(
      tooltipValue(item, effectiveChartMode),
      2
    )} ${unit}<br/>${runIds}`;
  };
  const formatAxisPointerLabel = (params: AxisPointerLabelParam) => {
    const numericValue = Number(params.value);
    if (params.axisDimension === "x") {
      return Number.isFinite(numericValue) ? `Effective TPS ${formatNumber(numericValue, 2)}` : `Effective TPS ${params.value}`;
    }
    return Number.isFinite(numericValue) ? `${formatNumber(numericValue, 2)} ${unit}` : String(params.value);
  };
  const formatXAxisLabel = (value: string | number) => {
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? formatNumber(numericValue, 0) : String(value);
  };
  const handleLegendSelectChanged = (event: LegendSelectChangedParam) => {
    if (event.selected) {
      setLegendSelected(event.selected);
      if (highlightedSeriesName && event.selected[highlightedSeriesName] === false) {
        setHighlightedSeriesName(null);
      }
    }
  };
  const handleChartMouseOver = (event: ChartMouseEventParam) => {
    if (event.componentType === "series" && event.seriesName && normalizedLegendSelected[event.seriesName]) {
      setHighlightedSeriesName(event.seriesName);
    }
  };
  const clearHighlightedSeries = () => {
    if (highlightedSeriesName) {
      setHighlightedSeriesName(null);
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
    xAxis: {
      type: "value",
      name: "Effective TPS",
      nameLocation: "middle",
      nameGap: 28,
      min: 0,
      max: lastEffectiveTps,
      axisLabel: {
        formatter: formatXAxisLabel
      }
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
    { header: "Scope", accessorKey: "scope" },
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
        <label>
          {config.scopeType === "topology" ? "Topology level" : "Scope"}
          <select value={scope} onChange={(event) => setScope(event.target.value)}>
            {scopeOptions.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
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
          onEvents={{
            globalout: clearHighlightedSeries,
            legendselectchanged: handleLegendSelectChanged,
            mouseout: clearHighlightedSeries,
            mouseover: handleChartMouseOver
          }}
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
