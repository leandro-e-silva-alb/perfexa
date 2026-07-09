import type { ColumnDef } from "@tanstack/react-table";
import EChartsReact from "echarts-for-react";
import {
  Activity,
  ChartArea,
  ChartLine,
  CircleAlert,
  Cpu,
  Gauge,
  HardDrive,
  Layers,
  ListFilter,
  Sigma,
  SlidersHorizontal,
  type LucideIcon
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DataTable } from "../../components/DataTable";
import { StatusPill } from "../../components/StatusPill";
import {
  formatNumber,
  metricUnit,
  measurementsForScope,
  runTestIdentities,
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

const metricIcons: Record<string, LucideIcon> = {
  latency: Gauge,
  error_rate: CircleAlert,
  cpu: Cpu,
  memory: HardDrive,
  throttling: Activity
};

function scopeOptionsForMetric(metric: MetricConfig, pkg: ImportedPackage | null | undefined): string[] {
  if (metric.scopeType === "run") {
    return ["run"];
  }

  return pkg ? buildTopologyGraph(pkg.topology).levels : [];
}

export function TestMetricsPage() {
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
    return runTestIdentities(activePackage)
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

  const unit = useMemo(() => (activePackage ? metricUnit(activePackage, metricId) : ""), [activePackage, metricId]);
  const selectedTestLabel = useMemo(
    () => testOptions.find((test) => test.key === selectedTestKey)?.label ?? "No test selected",
    [selectedTestKey, testOptions]
  );
  const seriesNames = useMemo(
    () => orderSeriesNames([...new Set(rows.map((row) => row.instance_id || row.scope))], topologyGraph, scope),
    [rows, scope, topologyGraph]
  );
  const normalizedLegendSelected = useMemo(
    () => Object.fromEntries(seriesNames.map((name) => [name, legendSelected[name] ?? true])),
    [legendSelected, seriesNames]
  );
  const visibleSeriesNames = useMemo(
    () => seriesNames.filter((name) => normalizedLegendSelected[name]),
    [normalizedLegendSelected, seriesNames]
  );
  const yAxisSeriesNames = visibleSeriesNames.length > 0 ? visibleSeriesNames : seriesNames;
  const effectiveTpsValues = useMemo(
    () => [...new Set(rows.map((row) => row.effective_tps))].sort((a, b) => a - b),
    [rows]
  );
  const lastEffectiveTps = effectiveTpsValues[effectiveTpsValues.length - 1];
  const seriesRowsByName = useMemo(() => {
    const nextRowsByName = new Map<string, MetricPoint[]>();
    for (const row of rows) {
      const seriesName = row.instance_id || row.scope;
      const seriesRows = nextRowsByName.get(seriesName) ?? [];
      seriesRows.push(row);
      nextRowsByName.set(seriesName, seriesRows);
    }
    for (const seriesRows of nextRowsByName.values()) {
      seriesRows.sort((a, b) => a.effective_tps - b.effective_tps || a.run_id.localeCompare(b.run_id));
    }
    return nextRowsByName;
  }, [rows]);
  const valuesBySeriesAndTps = useMemo(
    () =>
      rows.reduce((seriesMap, row) => {
        const seriesName = row.instance_id || row.scope;
        const tpsMap = seriesMap.get(seriesName) ?? new Map<number, { total: number; count: number; runIds: string[] }>();
        const bucket = tpsMap.get(row.effective_tps) ?? { total: 0, count: 0, runIds: [] };
        bucket.total += row.value;
        bucket.count += 1;
        bucket.runIds.push(row.run_id);
        tpsMap.set(row.effective_tps, bucket);
        seriesMap.set(seriesName, tpsMap);
        return seriesMap;
      }, new Map<string, Map<number, { total: number; count: number; runIds: string[] }>>()),
    [rows]
  );
  const stackedYAxisMax = useMemo(() => {
    const stackedTotalsByTps = effectiveTpsValues.map((effectiveTps) =>
      yAxisSeriesNames.reduce((sum, name) => {
        const bucket = valuesBySeriesAndTps.get(name)?.get(effectiveTps);
        return sum + (bucket ? bucket.total / bucket.count : 0);
      }, 0)
    );
    return niceAxisMax(Math.max(0, ...stackedTotalsByTps) * 1.08);
  }, [effectiveTpsValues, valuesBySeriesAndTps, yAxisSeriesNames]);
  const chartSeriesBase = useMemo(
    () =>
      seriesNames.map((name) => {
        const seriesRows = seriesRowsByName.get(name) ?? [];
        const isDerivedSeries = seriesRows.length > 0 && seriesRows.every((row) => row.source === "derived");
        const topologyNode = topologyGraph?.nodes.get(name);
        const seriesColor = topologyNode?.color;
        const lineStyleBase = {
          ...(isDerivedSeries ? { type: "dashed" } : {}),
          ...(seriesColor ? { color: seriesColor } : {})
        };
        const areaStyleBase = seriesColor ? { color: seriesColor } : {};
        const itemStyleBase = {
          borderWidth: 2,
          ...(seriesColor ? { borderColor: seriesColor } : {})
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
          areaStyleBase,
          itemStyleBase,
          lineStyleBase,
          option: {
            name,
            type: "line",
            color: seriesColor,
            dimensions:
              effectiveChartMode === "stackedArea"
                ? ["value", "effective_tps", "run_id"]
                : ["effective_tps", "value", "run_id"],
            encode: { x: "effective_tps", y: "value", tooltip: ["effective_tps", "value", "run_id"] },
            stack: effectiveChartMode === "stackedArea" ? "total" : undefined,
            triggerLineEvent: true,
            showSymbol: true,
            showAllSymbol: true,
            symbol: emptyChartSymbol(topologyNode?.symbol),
            symbolSize: 8,
            data
          }
        };
      }),
    [effectiveChartMode, effectiveTpsValues, seriesNames, seriesRowsByName, topologyGraph, valuesBySeriesAndTps]
  );
  const chartSeries = useMemo(
    () =>
      chartSeriesBase.map(({ areaStyleBase, itemStyleBase, lineStyleBase, name, option }) => {
        const isDimmedByHighlight = Boolean(highlightedSeriesName && highlightedSeriesName !== name);
        const lineOpacity = isDimmedByHighlight ? 0.2 : 1;
        const areaOpacity = isDimmedByHighlight ? 0.14 : 0.86;
        const pointOpacity = isDimmedByHighlight ? 0.28 : 1;
        const lineStyle = { ...lineStyleBase, opacity: lineOpacity };
        const areaStyle = { ...areaStyleBase, opacity: areaOpacity };
        const itemStyle = { ...itemStyleBase, opacity: pointOpacity };

        return {
          ...option,
          areaStyle: effectiveChartMode === "stackedArea" ? areaStyle : undefined,
          lineStyle,
          itemStyle,
          emphasis: {
            itemStyle: {
              ...itemStyleBase,
              opacity: pointOpacity,
              borderWidth: 3
            },
            lineStyle,
            areaStyle: effectiveChartMode === "stackedArea" ? areaStyle : undefined
          }
        };
      }),
    [chartSeriesBase, effectiveChartMode, highlightedSeriesName]
  );
  const tooltipMarker = useCallback(
    (param: TooltipParam): string => {
      const topologyNode = topologyGraph?.nodes.get(param.seriesName);
      const color = safeCssColor(topologyNode?.color ?? (typeof param.color === "string" ? param.color : undefined));
      return [
        '<span style="display:inline-flex;width:16px;height:14px;vertical-align:-2px;align-items:center;justify-content:center;">',
        `<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">`,
        tooltipShapeSvg(topologyNode?.symbol, color),
        "</svg>",
        "</span>"
      ].join("");
    },
    [topologyGraph]
  );
  const tooltipRow = useCallback(
    (item: TooltipParam): string => {
      const isHighlighted = item.seriesName === highlightedSeriesName;
      const isDimmed = Boolean(highlightedSeriesName && !isHighlighted);
      const style = [
        "display:grid",
        "grid-template-columns:16px minmax(92px,1fr) max-content",
        "align-items:center",
        "column-gap:6px",
        `opacity:${isDimmed ? "0.35" : "1"}`,
        `font-weight:${isHighlighted ? "700" : "400"}`
      ].join(";");
      const value = `${formatNumber(tooltipValue(item, effectiveChartMode), 2)} ${unit}`;

      return [
        `<span style="${style}">`,
        tooltipMarker(item),
        `<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(item.seriesName)}:</span>`,
        `<span style="font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap;">${escapeHtml(value)}</span>`,
        "</span>"
      ].join("");
    },
    [effectiveChartMode, highlightedSeriesName, tooltipMarker, unit]
  );
  const hiddenTooltipRow = useCallback(
    (hiddenItems: TooltipParam[]): string => {
      const hiddenTotal = hiddenItems.reduce((sum, item) => sum + tooltipValue(item, effectiveChartMode), 0);
      const value = isAdditiveMetric ? `${formatNumber(hiddenTotal, 2)} ${unit}` : "smaller values";
      const style = [
        "display:grid",
        "grid-template-columns:16px minmax(92px,1fr) max-content",
        "align-items:center",
        "column-gap:6px",
        `opacity:${highlightedSeriesName ? "0.35" : "1"}`,
        "font-weight:400"
      ].join(";");

      return [
        `<span style="${style}">`,
        "<span></span>",
        `<span style="white-space:nowrap;">+${hiddenItems.length} more:</span>`,
        `<span style="font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap;">${escapeHtml(value)}</span>`,
        "</span>"
      ].join("");
    },
    [effectiveChartMode, highlightedSeriesName, isAdditiveMetric, unit]
  );
  const formatTooltip = useCallback(
    (params: TooltipParam | TooltipParam[]) => {
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
          const valueDifference = tooltipValue(b, effectiveChartMode) - tooltipValue(a, effectiveChartMode);
          return valueDifference || a.seriesName.localeCompare(b.seriesName, undefined, { numeric: true });
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

        const tpsLabel = String(tps).startsWith("Effective TPS")
          ? escapeHtml(String(tps))
          : ` TPS ${escapeHtml(Number.isFinite(Number(tps)) ? formatNumber(Number(tps), 2) : String(tps))}`;
        const totalLine = [
          '<span style="display:grid;grid-template-columns:16px minmax(92px,1fr) max-content;align-items:center;column-gap:6px;">',
          "<span></span>",
          '<span>total:</span>',
          `<span style="font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap;">${formatNumber(total, 2)} ${unit}</span>`,
          "</span>"
        ].join("");

        return includeTotal
          ? [tpsLabel, totalLine, ...lines]
          : [tpsLabel, ...lines];
      };

      if (effectiveChartMode === "stackedArea") {
        const visibleItems = items.filter((item) => item.data && tooltipValue(item, effectiveChartMode) > 0);
        return formatTooltipRows(visibleItems, true).join("");
      }

      const lineItems = items.filter((item) => item.data);
      if (lineItems.length > 1) {
        const lines = formatTooltipRows(lineItems, isAdditiveMetric);
        return lines.join("");
      }

      const item = items[0];
      const tpsLabel = String(tps).startsWith("Effective TPS")
        ? escapeHtml(String(tps))
        : `Effective TPS ${escapeHtml(Number.isFinite(Number(tps)) ? formatNumber(Number(tps), 2) : String(tps))}`;
      return `${tpsLabel}<br/>${tooltipRow(item)}`;
    },
    [
      config.scopeType,
      effectiveChartMode,
      hiddenTooltipRow,
      highlightedSeriesName,
      isAdditiveMetric,
      tooltipMarker,
      tooltipRow,
      unit
    ]
  );
  const formatAxisPointerLabel = useCallback(
    (params: AxisPointerLabelParam) => {
      const numericValue = Number(params.value);
      if (params.axisDimension === "x") {
        return Number.isFinite(numericValue)
          ? `Effective TPS ${formatNumber(numericValue, 2)}`
          : `Effective TPS ${params.value}`;
      }
      return Number.isFinite(numericValue) ? `${formatNumber(numericValue, 2)} ${unit}` : String(params.value);
    },
    [unit]
  );
  const formatXAxisLabel = useCallback((value: string | number) => {
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? formatNumber(numericValue, 0) : String(value);
  }, []);
  const handleLegendSelectChanged = useCallback((event: LegendSelectChangedParam) => {
    if (event.selected) {
      setLegendSelected(event.selected);
      setHighlightedSeriesName((current) => (current && event.selected?.[current] === false ? null : current));
    }
  }, []);
  const handleChartMouseOver = useCallback(
    (event: ChartMouseEventParam) => {
      if (event.componentType === "series" && event.seriesName && normalizedLegendSelected[event.seriesName]) {
        setHighlightedSeriesName((current) => (current === event.seriesName ? current : event.seriesName ?? null));
      }
    },
    [normalizedLegendSelected]
  );
  const clearHighlightedSeries = useCallback(() => {
    setHighlightedSeriesName((current) => (current ? null : current));
  }, []);
  const chartOption = useMemo(
    () => ({
      animation: true,
      animationDuration: 240,
      animationDurationUpdate: 120,
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
    }),
    [
      chartSeries,
      effectiveChartMode,
      formatAxisPointerLabel,
      formatTooltip,
      formatXAxisLabel,
      lastEffectiveTps,
      normalizedLegendSelected,
      stackedYAxisMax,
      unit
    ]
  );
  const chartEvents = useMemo(
    () => ({
      globalout: clearHighlightedSeries,
      legendselectchanged: handleLegendSelectChanged,
      mouseover: handleChartMouseOver
    }),
    [clearHighlightedSeries, handleChartMouseOver, handleLegendSelectChanged]
  );
  const chartKey = `${activePackage?.id ?? "empty"}:${metricId}:${stat}:${scope}:${selectedTestKey}:${effectiveChartMode}`;
  const columns = useMemo<ColumnDef<MetricPoint>[]>(
    () => [
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
    ],
    []
  );

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

  return (
    <div className="page-stack page-stack-wide">
      <header className="page-header">
        <div>
          <p className="eyebrow">Test Metrics</p>
          <h1>{config.label}</h1>
          <span className="header-meta">{selectedTestLabel}</span>
        </div>
        <StatusPill tone={rows.length > 0 ? "ok" : "warn"}>{rows.length} facts</StatusPill>
      </header>

      <section className="panel test-metrics-controls-panel">
        <div className="test-metrics-workbar">
          <label className="test-metrics-filter-field test-metrics-filter-test">
            <span className="test-metrics-filter-label">
              <ListFilter size={15} aria-hidden="true" />
              Test
            </span>
            <select value={selectedTestKey} onChange={(event) => setSelectedTestKey(event.target.value)}>
              {testOptions.map((test) => (
                <option key={test.key} value={test.key}>
                  {test.label}
                </option>
              ))}
            </select>
          </label>

          <div className="test-metrics-filter-cluster">
            <span className="test-metrics-filter-label">
              <Activity size={15} aria-hidden="true" />
              Metric
            </span>
            <div className="test-metrics-filter-group" role="group" aria-label="Metric">
              {metricConfigs.map((metric) => {
                const MetricIcon = metricIcons[metric.id] ?? Activity;
                return (
                  <button
                    key={metric.id}
                    type="button"
                    className={metric.id === metricId ? "selected" : ""}
                    onClick={() => selectMetric(metric)}
                  >
                    <MetricIcon size={15} aria-hidden="true" />
                    <span>{metric.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <label className="test-metrics-filter-field test-metrics-filter-compact">
            <span className="test-metrics-filter-label">
              <Sigma size={15} aria-hidden="true" />
              Stat
            </span>
            <select value={stat} onChange={(event) => setStat(event.target.value)}>
              {availableStats.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>

          <label className="test-metrics-filter-field test-metrics-filter-compact">
            <span className="test-metrics-filter-label">
              <Layers size={15} aria-hidden="true" />
              {config.scopeType === "topology" ? "Topology level" : "Scope"}
            </span>
            <select value={scope} onChange={(event) => setScope(event.target.value)}>
              {scopeOptions.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>

          {canUseStackedArea ? (
            <div className="test-metrics-chart-mode" role="group" aria-label="Chart mode">
              <span className="test-metrics-filter-label">
                <SlidersHorizontal size={15} aria-hidden="true" />
                Chart
              </span>
              <div className="test-metrics-icon-toggle">
                <button
                  type="button"
                  className={effectiveChartMode === "line" ? "selected" : ""}
                  onClick={() => setChartMode("line")}
                  aria-label="Line chart"
                >
                  <ChartLine size={17} aria-hidden="true" />
                  <span className="control-tooltip">Lines</span>
                </button>
                <button
                  type="button"
                  className={effectiveChartMode === "stackedArea" ? "selected" : ""}
                  onClick={() => setChartMode("stackedArea")}
                  aria-label="Stacked area chart"
                >
                  <ChartArea size={17} aria-hidden="true" />
                  <span className="control-tooltip">Stacked area</span>
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </section>

      <section className="panel chart-panel">
        <EChartsReact
          key={chartKey}
          option={chartOption}
          onEvents={chartEvents}
          notMerge={false}
          lazyUpdate
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

