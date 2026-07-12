import EChartsReact from "echarts-for-react";
import { LayoutDashboard, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { formatNumber } from "../../domain/selectors";
import {
  clearDashboardCharts,
  listDashboardCharts,
  removeDashboardChart,
  subscribeDashboardCharts,
  type DashboardChart,
  type DashboardTooltipConfig
} from "../dashboardStore";

type DashboardChartDatum = [number, number, string];
type DashboardStackedAreaDatum = [number, number, string];
type DashboardTooltipParam = {
  seriesName: string;
  marker?: string;
  color?: string;
  data: DashboardChartDatum | DashboardStackedAreaDatum | number;
  value?: DashboardChartDatum | DashboardStackedAreaDatum | number;
  axisValue?: string | number;
  axisValueLabel?: string;
};
type DashboardAxisPointerLabelParam = { axisDimension?: string; value: string | number };
type DashboardLegendSelectChangedParam = { selected?: Record<string, boolean> };
type DashboardMouseEventParam = {
  componentType?: string;
  seriesName?: string;
};

const MAX_DASHBOARD_TOOLTIP_ITEMS = 8;
const animatedDashboardChartIds = new Set<string>();

function formatAddedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
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

function tooltipValue(param: DashboardTooltipParam, mode: DashboardTooltipConfig["chartMode"]): number {
  if (Array.isArray(param.data)) return mode === "stackedArea" ? param.data[0] : param.data[1];
  if (typeof param.data === "number") return param.data;
  return 0;
}

function sameTooltipSeries(left: DashboardTooltipParam, right: DashboardTooltipParam): boolean {
  return left.seriesName === right.seriesName;
}

function dashboardTooltipMarker(param: DashboardTooltipParam, tooltip: DashboardTooltipConfig): string {
  const topologyNode = tooltip.topologyNodes[param.seriesName];
  const color = safeCssColor(topologyNode?.color ?? (typeof param.color === "string" ? param.color : undefined));
  return [
    '<span style="display:inline-flex;width:16px;height:14px;vertical-align:-2px;align-items:center;justify-content:center;">',
    '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">',
    tooltipShapeSvg(topologyNode?.symbol, color),
    "</svg>",
    "</span>"
  ].join("");
}

function dashboardTooltipRow(
  item: DashboardTooltipParam,
  tooltip: DashboardTooltipConfig,
  highlightedSeriesName: string | null
): string {
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
  const value = `${formatNumber(tooltipValue(item, tooltip.chartMode), 2)} ${tooltip.unit}`;

  return [
    `<span style="${style}">`,
    dashboardTooltipMarker(item, tooltip),
    `<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(item.seriesName)}:</span>`,
    `<span style="font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap;">${escapeHtml(value)}</span>`,
    "</span>"
  ].join("");
}

function hiddenTooltipRow(
  hiddenItems: DashboardTooltipParam[],
  tooltip: DashboardTooltipConfig,
  highlightedSeriesName: string | null
): string {
  const hiddenTotal = hiddenItems.reduce((sum, item) => sum + tooltipValue(item, tooltip.chartMode), 0);
  const value = tooltip.isAdditiveMetric ? `${formatNumber(hiddenTotal, 2)} ${tooltip.unit}` : "smaller values";
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
}

function formatDashboardTooltip(
  params: DashboardTooltipParam | DashboardTooltipParam[],
  tooltip: DashboardTooltipConfig,
  highlightedSeriesName: string | null
): string {
  const items = Array.isArray(params) ? params : [params];
  const tps =
    items[0]?.axisValueLabel ??
    items[0]?.axisValue ??
    (Array.isArray(items[0]?.data)
      ? tooltip.chartMode === "stackedArea"
        ? items[0].data[1]
        : items[0].data[0]
      : "-");
  const formatTooltipRows = (tooltipItems: DashboardTooltipParam[], includeTotal: boolean) => {
    const sortedItems = [...tooltipItems].sort((a, b) => {
      const valueDifference = tooltipValue(b, tooltip.chartMode) - tooltipValue(a, tooltip.chartMode);
      return valueDifference || a.seriesName.localeCompare(b.seriesName, undefined, { numeric: true });
    });
    const isCompact = tooltip.scopeType === "topology" && sortedItems.length > MAX_DASHBOARD_TOOLTIP_ITEMS;
    const highlightedItem = highlightedSeriesName
      ? sortedItems.find((item) => item.seriesName === highlightedSeriesName)
      : undefined;
    const shownItems = isCompact ? sortedItems.slice(0, MAX_DASHBOARD_TOOLTIP_ITEMS) : sortedItems;
    const hiddenItems = isCompact ? sortedItems.slice(MAX_DASHBOARD_TOOLTIP_ITEMS) : [];
    const highlightedItemIsHidden = Boolean(
      highlightedItem && hiddenItems.some((item) => sameTooltipSeries(item, highlightedItem))
    );
    const visibleItems = highlightedItemIsHidden ? [...shownItems, highlightedItem as DashboardTooltipParam] : shownItems;
    const collapsedItems = highlightedItemIsHidden
      ? hiddenItems.filter((item) => !sameTooltipSeries(item, highlightedItem as DashboardTooltipParam))
      : hiddenItems;
    const total = sortedItems.reduce((sum, item) => sum + tooltipValue(item, tooltip.chartMode), 0);
    const lines = visibleItems.map((item) => dashboardTooltipRow(item, tooltip, highlightedSeriesName));

    if (collapsedItems.length > 0) {
      lines.push(hiddenTooltipRow(collapsedItems, tooltip, highlightedSeriesName));
    }

    const tpsLabel = String(tps).startsWith("Effective TPS")
      ? escapeHtml(String(tps))
      : ` TPS ${escapeHtml(Number.isFinite(Number(tps)) ? formatNumber(Number(tps), 2) : String(tps))}`;
    const totalLine = [
      '<span style="display:grid;grid-template-columns:16px minmax(92px,1fr) max-content;align-items:center;column-gap:6px;">',
      "<span></span>",
      "<span>total:</span>",
      `<span style="font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap;">${formatNumber(total, 2)} ${tooltip.unit}</span>`,
      "</span>"
    ].join("");

    return includeTotal ? [tpsLabel, totalLine, ...lines] : [tpsLabel, ...lines];
  };

  if (tooltip.chartMode === "stackedArea") {
    const visibleItems = items.filter((item) => item.data && tooltipValue(item, tooltip.chartMode) > 0);
    return formatTooltipRows(visibleItems, true).join("");
  }

  const lineItems = items.filter((item) => item.data);
  if (lineItems.length > 1) {
    return formatTooltipRows(lineItems, tooltip.isAdditiveMetric).join("");
  }

  const item = items[0];
  const tpsLabel = String(tps).startsWith("Effective TPS")
    ? escapeHtml(String(tps))
    : `Effective TPS ${escapeHtml(Number.isFinite(Number(tps)) ? formatNumber(Number(tps), 2) : String(tps))}`;
  return `${tpsLabel}<br/>${dashboardTooltipRow(item, tooltip, highlightedSeriesName)}`;
}

function formatAxisPointerLabel(params: DashboardAxisPointerLabelParam, unit: string): string {
  const numericValue = Number(params.value);
  if (params.axisDimension === "x") {
    return Number.isFinite(numericValue)
      ? `Effective TPS ${formatNumber(numericValue, 2)}`
      : `Effective TPS ${params.value}`;
  }
  return Number.isFinite(numericValue) ? `${formatNumber(numericValue, 2)} ${unit}` : String(params.value);
}

function formatXAxisLabel(value: string | number): string {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? formatNumber(numericValue, 0) : String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getSeriesName(series: unknown): string | undefined {
  return isRecord(series) && typeof series.name === "string" ? series.name : undefined;
}

function seriesNamesFromOption(option: Record<string, unknown>): string[] {
  return Array.isArray(option.series)
    ? option.series.map(getSeriesName).filter((name): name is string => Boolean(name))
    : [];
}

function withAxisFormatter(axis: unknown): unknown {
  if (Array.isArray(axis)) return axis.map(withAxisFormatter);
  if (!isRecord(axis)) return axis;
  return {
    ...axis,
    axisLabel: {
      ...(isRecord(axis.axisLabel) ? axis.axisLabel : {}),
      formatter: formatXAxisLabel
    }
  };
}

function withAnimationPolicy(option: Record<string, unknown>, allowInitialAnimation: boolean): Record<string, unknown> {
  const shouldAnimate = allowInitialAnimation && option.animation !== false;
  return {
    ...option,
    animation: shouldAnimate,
    animationDuration: shouldAnimate ? option.animationDuration : 0
  };
}

function withSeriesHighlight(
  series: unknown,
  tooltip: DashboardTooltipConfig,
  highlightedSeriesName: string | null
): unknown {
  if (Array.isArray(series)) {
    return series.map((item) => withSeriesHighlight(item, tooltip, highlightedSeriesName));
  }
  if (!isRecord(series)) return series;

  const name = getSeriesName(series);
  const isDimmedByHighlight = Boolean(highlightedSeriesName && highlightedSeriesName !== name);
  const lineOpacity = isDimmedByHighlight ? 0.2 : 1;
  const areaOpacity = isDimmedByHighlight ? 0.14 : 0.86;
  const pointOpacity = isDimmedByHighlight ? 0.28 : 1;
  const lineStyleBase = isRecord(series.lineStyle) ? series.lineStyle : {};
  const areaStyleBase = isRecord(series.areaStyle) ? series.areaStyle : {};
  const itemStyleBase = isRecord(series.itemStyle) ? series.itemStyle : {};
  const lineStyle = { ...lineStyleBase, opacity: lineOpacity };
  const areaStyle = { ...areaStyleBase, opacity: areaOpacity };
  const itemStyle = { ...itemStyleBase, opacity: pointOpacity };

  return {
    ...series,
    triggerLineEvent: true,
    showSymbol: true,
    showAllSymbol: true,
    areaStyle: tooltip.chartMode === "stackedArea" ? areaStyle : undefined,
    lineStyle,
    itemStyle,
    emphasis: {
      ...(isRecord(series.emphasis) ? series.emphasis : {}),
      itemStyle: {
        ...itemStyleBase,
        opacity: pointOpacity,
        borderWidth: 3
      },
      lineStyle,
      areaStyle: tooltip.chartMode === "stackedArea" ? areaStyle : undefined
    }
  };
}

function optionForDashboardChart(
  chart: DashboardChart,
  highlightedSeriesName: string | null,
  legendSelected: Record<string, boolean>,
  allowInitialAnimation: boolean
): Record<string, unknown> {
  if (!chart.tooltip) return withAnimationPolicy(chart.option, allowInitialAnimation);

  const tooltipOption = isRecord(chart.option.tooltip) ? chart.option.tooltip : {};
  const axisPointer = isRecord(tooltipOption.axisPointer) ? tooltipOption.axisPointer : {};
  const axisPointerLabel = isRecord(axisPointer.label) ? axisPointer.label : {};
  const legendOption = isRecord(chart.option.legend) ? chart.option.legend : {};

  return withAnimationPolicy({
    ...chart.option,
    legend: {
      ...legendOption,
      selected: legendSelected
    },
    tooltip: {
      ...tooltipOption,
      trigger: "axis",
      confine: true,
      axisPointer: {
        ...axisPointer,
        type: "cross",
        snap: true,
        label: {
          ...axisPointerLabel,
          backgroundColor: "#334155",
          formatter: (params: DashboardAxisPointerLabelParam) => formatAxisPointerLabel(params, chart.tooltip?.unit ?? "")
        }
      },
      formatter: (params: DashboardTooltipParam | DashboardTooltipParam[]) =>
        chart.tooltip ? formatDashboardTooltip(params, chart.tooltip, highlightedSeriesName) : ""
    },
    xAxis: withAxisFormatter(chart.option.xAxis),
    series: withSeriesHighlight(chart.option.series, chart.tooltip, highlightedSeriesName)
  }, allowInitialAnimation);
}

function initialLegendSelected(chart: DashboardChart): Record<string, boolean> {
  const legendOption = isRecord(chart.option.legend) ? chart.option.legend : {};
  const selected = isRecord(legendOption.selected) ? legendOption.selected : {};
  return Object.fromEntries(
    seriesNamesFromOption(chart.option).map((name) => [name, typeof selected[name] === "boolean" ? selected[name] : true])
  );
}

function DashboardChartCard({
  chart,
  onRemove
}: {
  chart: DashboardChart;
  onRemove(id: string): void;
}) {
  const [highlightedSeriesName, setHighlightedSeriesName] = useState<string | null>(null);
  const [legendSelected, setLegendSelected] = useState<Record<string, boolean>>(() => initialLegendSelected(chart));
  const [allowInitialAnimation] = useState(() => !animatedDashboardChartIds.has(chart.id));

  useEffect(() => {
    animatedDashboardChartIds.add(chart.id);
  }, [chart.id]);

  const chartOption = useMemo(
    () => optionForDashboardChart(chart, highlightedSeriesName, legendSelected, allowInitialAnimation),
    [allowInitialAnimation, chart, highlightedSeriesName, legendSelected]
  );
  const chartEvents = useMemo(
    () => ({
      globalout: () => setHighlightedSeriesName((current) => (current ? null : current)),
      legendselectchanged: (event: DashboardLegendSelectChangedParam) => {
        if (event.selected) {
          setLegendSelected(event.selected);
          setHighlightedSeriesName((current) => (current && event.selected?.[current] === false ? null : current));
        }
      },
      mouseover: (event: DashboardMouseEventParam) => {
        if (event.componentType === "series" && event.seriesName && legendSelected[event.seriesName] !== false) {
          setHighlightedSeriesName((current) => (current === event.seriesName ? current : event.seriesName ?? null));
        }
      }
    }),
    [legendSelected]
  );

  return (
    <article className="dashboard-chart-card">
      <header className="dashboard-chart-header">
        <div>
          <h2>{chart.title}</h2>
          <span>{chart.subtitle}</span>
        </div>
        <button
          className="icon-button"
          type="button"
          aria-label={`Remove ${chart.title}`}
          title="Remove chart"
          onClick={() => onRemove(chart.id)}
        >
          <Trash2 size={16} aria-hidden="true" />
        </button>
      </header>
      <EChartsReact
        option={chartOption}
        onEvents={chartEvents}
        notMerge={false}
        lazyUpdate
        style={{ height: 340, width: "100%" }}
      />
      <footer className="dashboard-chart-footer">
        <span>{chart.packageName}</span>
        <span>{chart.rowCount} facts</span>
        <span>{formatAddedAt(chart.createdAt)}</span>
      </footer>
    </article>
  );
}

export function DashboardPage() {
  const [charts, setCharts] = useState<DashboardChart[]>(() => listDashboardCharts());

  useEffect(() => {
    document.title = "Perfexa Dashboard";
    return subscribeDashboardCharts(() => setCharts(listDashboardCharts()));
  }, []);

  function handleRemoveChart(id: string) {
    removeDashboardChart(id);
    setCharts(listDashboardCharts());
  }

  function handleClearDashboard() {
    clearDashboardCharts();
    setCharts([]);
  }

  return (
    <main className="dashboard-page">
      <header className="dashboard-header">
        <div>
          <p className="eyebrow">Perfexa Dashboard</p>
          <h1>Metrics dashboard</h1>
          <span className="header-meta">{charts.length} chart{charts.length === 1 ? "" : "s"}</span>
        </div>
        <button
          className="button button-danger"
          type="button"
          onClick={handleClearDashboard}
          disabled={charts.length === 0}
        >
          <Trash2 size={16} aria-hidden="true" />
          Clear
        </button>
      </header>

      {charts.length === 0 ? (
        <section className="dashboard-empty">
          <LayoutDashboard size={36} aria-hidden="true" />
          <h2>No charts yet</h2>
        </section>
      ) : (
        <section className="dashboard-grid" aria-label="Dashboard charts">
          {charts.map((chart) => (
            <DashboardChartCard key={chart.id} chart={chart} onRemove={handleRemoveChart} />
          ))}
        </section>
      )}
    </main>
  );
}
