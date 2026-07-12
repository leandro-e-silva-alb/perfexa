import type { ColumnDef } from "@tanstack/react-table";
import EChartsReact from "echarts-for-react";
import {
  Activity,
  ChartArea,
  ChartLine,
  Check,
  ChevronDown,
  CircleAlert,
  Cpu,
  Gauge,
  HardDrive,
  Layers,
  LayoutDashboard,
  ListFilter,
  Search,
  Sigma,
  SlidersHorizontal,
  type LucideIcon
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DataTable } from "../../components/DataTable";
import { StatusPill } from "../../components/StatusPill";
import {
  formatNumber,
  metricUnit,
  measurementsForScope,
  RAW_SCOPE,
  runTestIdentities,
  testKeyFor,
  testNameFor,
  type MetricPoint
} from "../../domain/selectors";
import { buildTopologyGraph, type TopologyGraph } from "../../domain/topologyMetrics";
import type { ImportedPackage } from "../../domain/types";
import { useAppState } from "../AppState";
import { addDashboardChart, hasDashboardChart, subscribeDashboardCharts } from "../dashboardStore";
import { openDashboardWindow } from "../dashboardWindow";

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
  scopeType: "raw" | "topology";
};
type MetricGroupConfig = {
  id: string;
  label: string;
  metrics: MetricConfig[];
  availableCount: number;
};
type PopoverLayout = {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
};
type CompactSelectKind = "stat" | "scope";
type TestGroupBy = "scenario" | "exagon" | "none";
type TestOption = {
  key: string;
  label: string;
  scenarioId: string;
  scenarioName: string;
  configId: string;
  exagonVersion: string;
  sequenceId: number;
  runCount: number;
};
type TestOptionGroup = {
  key: string;
  label: string;
  options: TestOption[];
};

const MAX_TOPOLOGY_TOOLTIP_ITEMS = 8;
const MORE_POPOVER_MAX_WIDTH = 720;
const MORE_POPOVER_MIN_WIDTH = 360;
const MORE_POPOVER_MARGIN = 12;
const COMPACT_POPOVER_MIN_WIDTH = 200;
const COMPACT_POPOVER_MAX_WIDTH = 280;
const TEST_POPOVER_MIN_WIDTH = 540;
const TEST_POPOVER_MAX_WIDTH = 820;
const OTHER_METRIC_GROUP_ID = "__other__";
const OTHER_METRIC_GROUP_LABEL = "Other";
const TEST_GROUP_OPTIONS: { value: TestGroupBy; label: string }[] = [
  { value: "scenario", label: "Scenario" },
  { value: "exagon", label: "Exagon version" },
  { value: "none", label: "None" }
];

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
  { id: "latency", label: "Latency", defaultStat: "p95", fallbackStats: ["avg"], scopeType: "raw" },
  { id: "error_rate", label: "Errors", defaultStat: "avg", scopeType: "raw" },
  { id: "cpu", label: "CPU", defaultStat: "avg", scopeType: "topology" },
  { id: "memory", label: "Memory", defaultStat: "avg", scopeType: "topology" },
  { id: "throttling", label: "Throttling", defaultStat: "max", scopeType: "topology" }
];
const fallbackFavoriteMetricIds = metricConfigs.map((metric) => metric.id);

const metricIcons: Record<string, LucideIcon> = {
  latency: Gauge,
  error_rate: CircleAlert,
  cpu: Cpu,
  memory: HardDrive,
  throttling: Activity
};

const knownMetricConfigs = new Map(metricConfigs.map((metric) => [metric.id, metric]));
const preferredDynamicStats = ["avg", "p95", "p99", "p90", "max", "effective", "total", "sum", "count", "min"];

function orderedMetricStats(stats: string[]): string[] {
  const uniqueStats = [...new Set(stats)];
  return [
    ...preferredDynamicStats.filter((stat) => uniqueStats.includes(stat)),
    ...uniqueStats.filter((stat) => !preferredDynamicStats.includes(stat)).sort()
  ];
}

function metricLabel(pkg: ImportedPackage, metricId: string): string {
  const knownLabel = knownMetricConfigs.get(metricId)?.label;
  if (knownLabel) return knownLabel;

  const description = pkg.metrics.metrics[metricId]?.description?.trim().replace(/\.$/, "");
  if (description) return description;

  return metricId
    .split("_")
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLowerCase();
      if (lower === "cpu") return "CPU";
      if (lower === "io") return "IO";
      if (lower === "iops") return "IOPS";
      return `${part.charAt(0).toUpperCase()}${part.slice(1)}`;
    })
    .join(" ");
}

function statsForMetric(pkg: ImportedPackage, metricId: string): string[] {
  return orderedMetricStats(
    pkg.measurements
      .filter((measurement) => measurement.metric_id === metricId)
      .map((measurement) => measurement.stat)
  );
}

function scopeOptionsForMetric(metric: MetricConfig, pkg: ImportedPackage | null | undefined): string[] {
  if (metric.scopeType === "raw") {
    return [RAW_SCOPE];
  }

  return pkg ? buildTopologyGraph(pkg.topology).levels : [];
}

function scopeTypeForMetric(
  pkg: ImportedPackage | null | undefined,
  metricId: string,
  fallback: MetricConfig["scopeType"]
): MetricConfig["scopeType"] {
  if (!pkg) return fallback;
  return pkg.metrics.metrics[metricId]?.topology ? "topology" : "raw";
}

function metricConfigForPackage(
  metric: MetricConfig,
  pkg: ImportedPackage | null | undefined
): MetricConfig {
  return {
    ...metric,
    scopeType: scopeTypeForMetric(pkg, metric.id, metric.scopeType)
  };
}

function metricConfigForPackageMetric(pkg: ImportedPackage, metricId: string): MetricConfig {
  const knownConfig = knownMetricConfigs.get(metricId);
  const stats = statsForMetric(pkg, metricId);
  const defaultStat = knownConfig?.defaultStat ?? stats[0] ?? "avg";
  const fallbackStats = [
    ...(knownConfig?.fallbackStats ?? []),
    ...stats.filter((item) => item !== defaultStat && !(knownConfig?.fallbackStats ?? []).includes(item))
  ];

  return metricConfigForPackage(
    {
      id: metricId,
      label: metricLabel(pkg, metricId),
      defaultStat,
      fallbackStats,
      scopeType: knownConfig?.scopeType ?? "raw"
    },
    pkg
  );
}

function metricAvailableForTest(
  pkg: ImportedPackage,
  selectedRunIds: ReadonlySet<string>,
  selectedTestKey: string,
  metric: MetricConfig
): boolean {
  if (!selectedTestKey || selectedRunIds.size === 0) return false;

  const stats = availableStatsForMetric(pkg, selectedRunIds, metric);
  const defaultScope = scopeOptionsForMetric(metric, pkg)[0] ?? RAW_SCOPE;

  return stats.some((candidateStat) => {
    try {
      return measurementsForScope(pkg, metric.id, candidateStat, defaultScope, selectedTestKey).some(
        (row) => row.test_key === selectedTestKey
      );
    } catch {
      return false;
    }
  });
}

function metricGroupForMetric(pkg: ImportedPackage, metricId: string): { id: string; label: string } {
  const groupId = pkg.metrics.metrics[metricId]?.group;
  const groups = pkg.metrics.groups ?? {};
  if (groupId && groups[groupId]) {
    return { id: groupId, label: groups[groupId].name };
  }

  return { id: OTHER_METRIC_GROUP_ID, label: OTHER_METRIC_GROUP_LABEL };
}

function moreMetricGroupsForPackage(
  pkg: ImportedPackage,
  metrics: MetricConfig[],
  availability: ReadonlyMap<string, boolean>
): MetricGroupConfig[] {
  const groups = new Map<string, MetricGroupConfig>();
  const ensureGroup = (id: string, label: string): MetricGroupConfig => {
    const existing = groups.get(id);
    if (existing) return existing;
    const next = { id, label, metrics: [], availableCount: 0 };
    groups.set(id, next);
    return next;
  };

  for (const [id, group] of Object.entries(pkg.metrics.groups ?? {})) {
    ensureGroup(id, group.name);
  }

  for (const metric of metrics) {
    const group = metricGroupForMetric(pkg, metric.id);
    const entry = ensureGroup(group.id, group.label);
    entry.metrics.push(metric);
    if (availability.get(metric.id)) {
      entry.availableCount += 1;
    }
  }

  return [...groups.values()]
    .filter((group) => group.metrics.length > 0)
    .map((group) => ({
      ...group,
      metrics: [...group.metrics].sort((left, right) =>
        left.label.localeCompare(right.label, undefined, { numeric: true })
      )
    }));
}

function testOptionSearchText(option: TestOption): string {
  return [
    option.label,
    option.scenarioName,
    option.scenarioId,
    option.exagonVersion,
    option.configId,
    `#${option.sequenceId}`
  ].join(" ");
}

function groupTestOptions(options: TestOption[], groupBy: TestGroupBy): TestOptionGroup[] {
  if (groupBy === "none") {
    return [{ key: "all", label: "All tests", options }];
  }

  const groups = new Map<string, TestOptionGroup>();
  const ensureGroup = (key: string, label: string): TestOptionGroup => {
    const existing = groups.get(key);
    if (existing) return existing;
    const next = { key, label, options: [] };
    groups.set(key, next);
    return next;
  };

  for (const option of options) {
    if (groupBy === "scenario") {
      ensureGroup(`scenario:${option.scenarioId}`, option.scenarioName).options.push(option);
    } else {
      ensureGroup(`exagon:${option.exagonVersion}`, option.exagonVersion).options.push(option);
    }
  }

  return [...groups.values()].sort((left, right) =>
    left.label.localeCompare(right.label, undefined, { numeric: true })
  );
}

function testGroupingLabel(groupBy: TestGroupBy): string {
  if (groupBy === "scenario") return "Scenario";
  if (groupBy === "exagon") return "Exagon version";
  return "Group";
}

function testOptionLabelForGroup(option: TestOption, groupBy: TestGroupBy): string {
  if (groupBy === "scenario") return `${option.exagonVersion} » #${option.sequenceId}`;
  if (groupBy === "exagon") return `${option.scenarioName} » #${option.sequenceId}`;
  return option.label;
}

function testRunCountLabel(runCount: number): string {
  return runCount === 1 ? "1 run" : `${runCount} runs`;
}

export function TestMetricsPage() {
  const { activePackage, setView } = useAppState();
  const [metricId, setMetricId] = useState("latency");
  const [stat, setStat] = useState("p95");
  const [scope, setScope] = useState<Scope>(RAW_SCOPE);
  const [selectedTestKey, setSelectedTestKey] = useState("");
  const [chartMode, setChartMode] = useState<ChartMode>("line");
  const [legendSelected, setLegendSelected] = useState<Record<string, boolean>>({});
  const [highlightedSeriesName, setHighlightedSeriesName] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [activeMetricGroupId, setActiveMetricGroupId] = useState(OTHER_METRIC_GROUP_ID);
  const [metricSearch, setMetricSearch] = useState("");
  const [morePopoverLayout, setMorePopoverLayout] = useState<PopoverLayout | null>(null);
  const [compactSelectOpen, setCompactSelectOpen] = useState<CompactSelectKind | null>(null);
  const [compactSelectLayout, setCompactSelectLayout] = useState<PopoverLayout | null>(null);
  const [testSelectorOpen, setTestSelectorOpen] = useState(false);
  const [testSearch, setTestSearch] = useState("");
  const [testGroupBy, setTestGroupBy] = useState<TestGroupBy>("scenario");
  const [testPopoverLayout, setTestPopoverLayout] = useState<PopoverLayout | null>(null);
  const [dashboardFeedback, setDashboardFeedback] = useState<"idle" | "added" | "exists">("idle");
  const [dashboardRevision, setDashboardRevision] = useState(0);
  const morePopoverHostRef = useRef<HTMLDivElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const morePopoverRef = useRef<HTMLDivElement>(null);
  const statSelectHostRef = useRef<HTMLDivElement>(null);
  const statSelectButtonRef = useRef<HTMLButtonElement>(null);
  const scopeSelectHostRef = useRef<HTMLDivElement>(null);
  const scopeSelectButtonRef = useRef<HTMLButtonElement>(null);
  const compactSelectPopoverRef = useRef<HTMLDivElement>(null);
  const testSelectorHostRef = useRef<HTMLDivElement>(null);
  const testSelectorButtonRef = useRef<HTMLButtonElement>(null);
  const testSelectorPopoverRef = useRef<HTMLDivElement>(null);
  const dashboardFeedbackTimeoutRef = useRef<number | undefined>();

  const testOptions = useMemo(() => {
    if (!activePackage) return [];
    const scenariosById = new Map(activePackage.scenarios.map((scenario) => [scenario.scenario_id, scenario]));
    const configsById = new Map(activePackage.configs.map((config) => [config.config_id, config]));
    const runCountByTestKey = new Map<string, number>();
    for (const run of activePackage.runs) {
      const key = testKeyFor(run);
      runCountByTestKey.set(key, (runCountByTestKey.get(key) ?? 0) + 1);
    }

    return runTestIdentities(activePackage)
      .map((test): TestOption => {
        const key = testKeyFor(test);
        return {
          key,
          label: testNameFor(activePackage, test),
          scenarioId: test.scenario_id,
          scenarioName: scenariosById.get(test.scenario_id)?.name ?? test.scenario_id,
          configId: test.config_id,
          exagonVersion: configsById.get(test.config_id)?.exagon_ver ?? test.config_id,
          sequenceId: test.sequence_id,
          runCount: runCountByTestKey.get(key) ?? 0
        };
      })
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  }, [activePackage]);
  const selectedTestOption = useMemo(
    () => testOptions.find((test) => test.key === selectedTestKey),
    [selectedTestKey, testOptions]
  );
  const filteredTestOptions = useMemo(() => {
    const normalizedSearch = testSearch.trim().toLowerCase();
    if (!normalizedSearch) return testOptions;

    return testOptions.filter((test) => testOptionSearchText(test).toLowerCase().includes(normalizedSearch));
  }, [testOptions, testSearch]);
  const groupedTestOptions = useMemo(
    () => groupTestOptions(filteredTestOptions, testGroupBy),
    [filteredTestOptions, testGroupBy]
  );
  const topologyGraph = useMemo(() => {
    return activePackage ? buildTopologyGraph(activePackage.topology) : null;
  }, [activePackage]);

  useEffect(() => {
    setSelectedTestKey((current) =>
      current && testOptions.some((test) => test.key === current) ? current : testOptions[0]?.key ?? ""
    );
  }, [testOptions]);

  useEffect(() => {
    setMoreOpen(false);
    setMetricSearch("");
    setActiveMetricGroupId(OTHER_METRIC_GROUP_ID);
    setMorePopoverLayout(null);
    setCompactSelectOpen(null);
    setCompactSelectLayout(null);
    setTestSelectorOpen(false);
    setTestSearch("");
    setTestPopoverLayout(null);
  }, [activePackage?.id]);

  useEffect(() => {
    return () => {
      if (dashboardFeedbackTimeoutRef.current !== undefined) {
        window.clearTimeout(dashboardFeedbackTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    return subscribeDashboardCharts(() => setDashboardRevision((revision) => revision + 1));
  }, []);

  const layoutForButton = useCallback((
    button: HTMLButtonElement,
    minWidth: number,
    maxWidth: number,
    sizing: "fixed" | "button"
  ): PopoverLayout => {
    const buttonRect = button.getBoundingClientRect();
    const contentRect = document.querySelector(".content-column")?.getBoundingClientRect();
    const safeLeft = Math.max(MORE_POPOVER_MARGIN, (contentRect?.left ?? 0) + MORE_POPOVER_MARGIN);
    const safeRight = Math.min(
      window.innerWidth - MORE_POPOVER_MARGIN,
      (contentRect?.right ?? window.innerWidth) - MORE_POPOVER_MARGIN
    );
    const availableWidth = Math.max(minWidth, safeRight - safeLeft);
    const preferredWidth = sizing === "fixed" ? maxWidth : Math.max(buttonRect.width, minWidth);
    const width = Math.min(preferredWidth, maxWidth, availableWidth);
    const preferredLeft = buttonRect.right - width;
    const left = Math.min(Math.max(preferredLeft, safeLeft), safeRight - width);

    return {
      top: buttonRect.bottom + 8,
      left,
      width,
      maxHeight: Math.max(260, window.innerHeight - buttonRect.bottom - 8 - MORE_POPOVER_MARGIN)
    };
  }, []);

  const updateMorePopoverLayout = useCallback(() => {
    const button = moreButtonRef.current;
    if (!button || typeof window === "undefined") return;

    setMorePopoverLayout(layoutForButton(button, MORE_POPOVER_MIN_WIDTH, MORE_POPOVER_MAX_WIDTH, "fixed"));
  }, [layoutForButton]);

  const updateCompactSelectLayout = useCallback((kind: CompactSelectKind | null = compactSelectOpen) => {
    if (!kind || typeof window === "undefined") return;

    const button = kind === "stat" ? statSelectButtonRef.current : scopeSelectButtonRef.current;
    if (!button) return;

    setCompactSelectLayout(layoutForButton(button, COMPACT_POPOVER_MIN_WIDTH, COMPACT_POPOVER_MAX_WIDTH, "button"));
  }, [compactSelectOpen, layoutForButton]);

  const updateTestPopoverLayout = useCallback(() => {
    const button = testSelectorButtonRef.current;
    if (!button || typeof window === "undefined") return;

    setTestPopoverLayout(layoutForButton(button, TEST_POPOVER_MIN_WIDTH, TEST_POPOVER_MAX_WIDTH, "fixed"));
  }, [layoutForButton]);

  useLayoutEffect(() => {
    if (!moreOpen) {
      setMorePopoverLayout(null);
      return;
    }

    updateMorePopoverLayout();
  }, [moreOpen, updateMorePopoverLayout]);

  useEffect(() => {
    if (!moreOpen) return;

    const updateLayout = () => updateMorePopoverLayout();
    window.addEventListener("resize", updateLayout);
    window.addEventListener("scroll", updateLayout, true);
    return () => {
      window.removeEventListener("resize", updateLayout);
      window.removeEventListener("scroll", updateLayout, true);
    };
  }, [moreOpen, updateMorePopoverLayout]);

  useEffect(() => {
    if (!moreOpen) return;

    function closeMoreOnOutsidePointerDown(event: PointerEvent): void {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (!morePopoverHostRef.current?.contains(target) && !morePopoverRef.current?.contains(target)) {
        setMoreOpen(false);
      }
    }

    document.addEventListener("pointerdown", closeMoreOnOutsidePointerDown);
    return () => document.removeEventListener("pointerdown", closeMoreOnOutsidePointerDown);
  }, [moreOpen]);

  useLayoutEffect(() => {
    if (!compactSelectOpen) {
      setCompactSelectLayout(null);
      return;
    }

    updateCompactSelectLayout(compactSelectOpen);
  }, [compactSelectOpen, updateCompactSelectLayout]);

  useEffect(() => {
    if (!compactSelectOpen) return;

    const updateLayout = () => updateCompactSelectLayout(compactSelectOpen);
    window.addEventListener("resize", updateLayout);
    window.addEventListener("scroll", updateLayout, true);
    return () => {
      window.removeEventListener("resize", updateLayout);
      window.removeEventListener("scroll", updateLayout, true);
    };
  }, [compactSelectOpen, updateCompactSelectLayout]);

  useEffect(() => {
    if (!compactSelectOpen) return;

    function closeCompactSelectOnOutsidePointerDown(event: PointerEvent): void {
      const target = event.target;
      if (!(target instanceof Node)) return;

      const activeHost = compactSelectOpen === "stat" ? statSelectHostRef.current : scopeSelectHostRef.current;
      if (!activeHost?.contains(target) && !compactSelectPopoverRef.current?.contains(target)) {
        setCompactSelectOpen(null);
      }
    }

    document.addEventListener("pointerdown", closeCompactSelectOnOutsidePointerDown);
    return () => document.removeEventListener("pointerdown", closeCompactSelectOnOutsidePointerDown);
  }, [compactSelectOpen]);

  useLayoutEffect(() => {
    if (!testSelectorOpen) {
      setTestPopoverLayout(null);
      return;
    }

    updateTestPopoverLayout();
  }, [testSelectorOpen, updateTestPopoverLayout]);

  useEffect(() => {
    if (!testSelectorOpen) return;

    const updateLayout = () => updateTestPopoverLayout();
    window.addEventListener("resize", updateLayout);
    window.addEventListener("scroll", updateLayout, true);
    return () => {
      window.removeEventListener("resize", updateLayout);
      window.removeEventListener("scroll", updateLayout, true);
    };
  }, [testSelectorOpen, updateTestPopoverLayout]);

  useEffect(() => {
    if (!testSelectorOpen) return;

    function closeTestSelectorOnOutsidePointerDown(event: PointerEvent): void {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (!testSelectorHostRef.current?.contains(target) && !testSelectorPopoverRef.current?.contains(target)) {
        setTestSelectorOpen(false);
      }
    }

    document.addEventListener("pointerdown", closeTestSelectorOnOutsidePointerDown);
    return () => document.removeEventListener("pointerdown", closeTestSelectorOnOutsidePointerDown);
  }, [testSelectorOpen]);

  const selectedRunIds = useMemo(() => {
    if (!activePackage || !selectedTestKey) return new Set<string>();
    return new Set(
      activePackage.runs
        .filter((run) => testKeyFor(run) === selectedTestKey)
        .map((run) => run.run_id)
    );
  }, [activePackage, selectedTestKey]);

  const allMetricConfigs = useMemo(
    () =>
      activePackage
        ? Object.keys(activePackage.metrics.metrics).map((metricId) => metricConfigForPackageMetric(activePackage, metricId))
        : metricConfigs,
    [activePackage]
  );
  const favoriteMetricIds = useMemo(() => {
    if (!activePackage) return fallbackFavoriteMetricIds;

    const configuredFavorites = (activePackage.metrics.favorites ?? []).filter(
      (metricId) => activePackage.metrics.metrics[metricId]
    );
    const favoriteIds = configuredFavorites.length > 0 ? configuredFavorites : fallbackFavoriteMetricIds;
    return favoriteIds.filter((metricId) => activePackage.metrics.metrics[metricId]);
  }, [activePackage]);
  const favoriteMetricIdSet = useMemo(() => new Set(favoriteMetricIds), [favoriteMetricIds]);
  const fixedMetricConfigs = useMemo(
    () => favoriteMetricIds
      .map((metricId) => allMetricConfigs.find((metric) => metric.id === metricId))
      .filter((metric): metric is MetricConfig => Boolean(metric)),
    [allMetricConfigs, favoriteMetricIds]
  );
  const extraMetricConfigs = useMemo(
    () =>
      allMetricConfigs
        .filter((metric) => !favoriteMetricIdSet.has(metric.id))
        .sort((left, right) => left.label.localeCompare(right.label, undefined, { numeric: true })),
    [allMetricConfigs, favoriteMetricIdSet]
  );
  const selectedMetricConfig = allMetricConfigs.find((item) => item.id === metricId);
  const config = selectedMetricConfig ?? allMetricConfigs[0] ?? metricConfigs[0];
  const activeMetricId = selectedMetricConfig?.id ?? config.id;
  const selectedExtraMetricId = extraMetricConfigs.some((metric) => metric.id === activeMetricId) ? activeMetricId : "";
  const metricAvailability = useMemo(() => {
    const availability = new Map<string, boolean>();
    if (!activePackage) return availability;

    for (const metric of allMetricConfigs) {
      availability.set(metric.id, metricAvailableForTest(activePackage, selectedRunIds, selectedTestKey, metric));
    }

    return availability;
  }, [activePackage, allMetricConfigs, selectedRunIds, selectedTestKey]);
  const selectedMetricHasData = metricAvailability.get(activeMetricId) ?? false;
  const moreMetricGroups = useMemo(
    () => activePackage ? moreMetricGroupsForPackage(activePackage, extraMetricConfigs, metricAvailability) : [],
    [activePackage, extraMetricConfigs, metricAvailability]
  );
  const activeMetricGroup = moreMetricGroups.find((group) => group.id === activeMetricGroupId) ?? moreMetricGroups[0];
  const visibleMoreMetrics = useMemo(() => {
    const normalizedSearch = metricSearch.trim().toLowerCase();
    const metrics = activeMetricGroup?.metrics ?? [];
    if (!normalizedSearch) return metrics;

    return metrics.filter((metric) => {
      const unit = activePackage ? metricUnit(activePackage, metric.id) : "";
      return [metric.label, metric.id, unit].join(" ").toLowerCase().includes(normalizedSearch);
    });
  }, [activeMetricGroup, activePackage, metricSearch]);

  useEffect(() => {
    if (!moreOpen || moreMetricGroups.length === 0) return;

    setActiveMetricGroupId((current) => {
      if (moreMetricGroups.some((group) => group.id === current)) return current;
      if (selectedExtraMetricId && activePackage) {
        const selectedGroup = metricGroupForMetric(activePackage, selectedExtraMetricId);
        if (moreMetricGroups.some((group) => group.id === selectedGroup.id)) return selectedGroup.id;
      }
      return moreMetricGroups[0].id;
    });
  }, [activePackage, moreMetricGroups, moreOpen, selectedExtraMetricId]);

  const availableStats = useMemo(() => {
    return availableStatsForMetric(activePackage, selectedRunIds, config);
  }, [activePackage, config, selectedRunIds]);
  const statOptions = availableStats.length > 0 ? availableStats : [stat || config.defaultStat];

  useEffect(() => {
    if (selectedMetricHasData && !availableStats.includes(stat)) {
      setStat(availableStats[0] ?? config.defaultStat);
    }
  }, [availableStats, config.defaultStat, selectedMetricHasData, stat]);

  useEffect(() => {
    setLegendSelected({});
    setHighlightedSeriesName(null);
  }, [activeMetricId, chartMode, scope, selectedTestKey, stat]);

  const scopeOptions = useMemo(() => {
    return scopeOptionsForMetric(config, activePackage);
  }, [activePackage, config]);

  useEffect(() => {
    if (!scopeOptions.includes(scope)) {
      setScope(scopeOptions[0] ?? RAW_SCOPE);
    }
  }, [scope, scopeOptions]);

  useEffect(() => {
    if (config.scopeType !== "topology" && compactSelectOpen === "scope") {
      setCompactSelectOpen(null);
    }
  }, [compactSelectOpen, config.scopeType]);

  const rows = useMemo(() => {
    if (!activePackage || !selectedTestKey) return [];
    try {
      return measurementsForScope(activePackage, activeMetricId, stat, scope, selectedTestKey).filter(
        (row) => row.test_key === selectedTestKey
      );
    } catch {
      return [];
    }
  }, [activeMetricId, activePackage, scope, selectedTestKey, stat]);

  const isAdditiveMetric = activePackage?.metrics.metrics[activeMetricId]?.topology?.aggregation === "sum" && config.scopeType === "topology";
  const canUseStackedArea = isAdditiveMetric && scope !== RAW_SCOPE;
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
    setScope(nextScopes[0] ?? RAW_SCOPE);
    setLegendSelected({});
    setMoreOpen(false);
    setCompactSelectOpen(null);
    setTestSelectorOpen(false);
    setMetricSearch("");
    if (
      activePackage?.metrics.metrics[metric.id]?.topology?.aggregation !== "sum" ||
      metric.scopeType !== "topology" ||
      (nextScopes[0] ?? RAW_SCOPE) === RAW_SCOPE
    ) {
      setChartMode("line");
    }
  };

  const unit = useMemo(() => (activePackage ? metricUnit(activePackage, activeMetricId) : ""), [activeMetricId, activePackage]);
  const selectedTestLabel = selectedTestOption?.label ?? "No test selected";
  const seriesNames = useMemo(
    () => orderSeriesNames([...new Set(rows.map((row) => row.instance_id || row.metric_id))], topologyGraph, scope),
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
      const seriesName = row.instance_id || row.metric_id;
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
        const seriesName = row.instance_id || row.metric_id;
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
  const chartKey = `${activePackage?.id ?? "empty"}:${activeMetricId}:${stat}:${scope}:${selectedTestKey}:${effectiveChartMode}`;
  const currentChartAlreadyOnDashboard = useMemo(
    () => rows.length > 0 && hasDashboardChart(chartKey),
    [chartKey, dashboardRevision, rows.length]
  );

  const addCurrentChartToDashboard = async () => {
    if (!activePackage || rows.length === 0) return;

    if (hasDashboardChart(chartKey)) {
      await openDashboardWindow();
      setDashboardFeedback("exists");
      if (dashboardFeedbackTimeoutRef.current !== undefined) {
        window.clearTimeout(dashboardFeedbackTimeoutRef.current);
      }
      dashboardFeedbackTimeoutRef.current = window.setTimeout(() => {
        setDashboardFeedback("idle");
        dashboardFeedbackTimeoutRef.current = undefined;
      }, 1600);
      return;
    }

    const modeLabel = effectiveChartMode === "stackedArea" ? "Stacked area" : "Line";
    const subtitleParts = [
      selectedTestLabel,
      stat,
      config.scopeType === "topology" ? scope : undefined,
      modeLabel
    ].filter((part): part is string => Boolean(part));

    const topologyNodes = Object.fromEntries(
      seriesNames.map((name) => {
        const node = topologyGraph?.nodes.get(name);
        return [name, { color: node?.color, symbol: node?.symbol }];
      })
    );
    const result = addDashboardChart({
      identityKey: chartKey,
      title: config.label,
      subtitle: subtitleParts.join(" / "),
      packageId: activePackage.id,
      packageName: activePackage.name,
      rowCount: rows.length,
      option: chartOption,
      tooltip: {
        unit,
        chartMode: effectiveChartMode,
        scopeType: config.scopeType,
        isAdditiveMetric,
        topologyNodes
      }
    });
    await openDashboardWindow();

    setDashboardRevision((revision) => revision + 1);
    setDashboardFeedback(result.added ? "added" : "exists");
    if (dashboardFeedbackTimeoutRef.current !== undefined) {
      window.clearTimeout(dashboardFeedbackTimeoutRef.current);
    }
    dashboardFeedbackTimeoutRef.current = window.setTimeout(() => {
      setDashboardFeedback("idle");
      dashboardFeedbackTimeoutRef.current = undefined;
    }, 1600);
  };
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
  const compactSelectOptions = compactSelectOpen === "stat" ? statOptions : scopeOptions;
  const compactSelectValue = compactSelectOpen === "stat" ? stat : scope;
  const selectCompactOption = (value: string) => {
    if (compactSelectOpen === "stat") {
      setStat(value);
    } else if (compactSelectOpen === "scope") {
      setScope(value);
    }
    setCompactSelectOpen(null);
  };

  const selectTestOption = (option: TestOption) => {
    setSelectedTestKey(option.key);
    setTestSelectorOpen(false);
    setTestSearch("");
  };

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
        <div className="header-actions">
          <button
            className="button"
            type="button"
            onClick={addCurrentChartToDashboard}
            disabled={rows.length === 0}
          >
            <LayoutDashboard size={16} aria-hidden="true" />
            {dashboardFeedback === "added"
              ? "Added"
              : dashboardFeedback === "exists" || currentChartAlreadyOnDashboard
                ? "In dashboard"
                : "Add to dashboard"}
          </button>
          <StatusPill tone={rows.length > 0 ? "ok" : "warn"}>{rows.length} facts</StatusPill>
        </div>
      </header>

      <section className="panel test-metrics-controls-panel">
        <div className="test-metrics-workbar">


          <div className="test-metrics-workbar-row">
            <div className="test-metrics-filter-cluster">
              <span className="test-metrics-filter-label">
                <Activity size={15} aria-hidden="true" />
                Metric
              </span>
              <div className="test-metrics-filter-group" role="group" aria-label="Metric">
                {fixedMetricConfigs.map((metric) => {
                  const MetricIcon = metricIcons[metric.id] ?? Activity;
                  const isAvailable = metricAvailability.get(metric.id) ?? false;
                  return (
                    <button
                      key={metric.id}
                      type="button"
                      className={metric.id === activeMetricId ? "selected" : ""}
                      disabled={!isAvailable}
                      onClick={() => selectMetric(metric)}
                    >
                      <MetricIcon size={15} aria-hidden="true" />
                      <span>{metric.label}</span>
                    </button>
                  );
                })}
                {extraMetricConfigs.length > 0 ? (
                  <div className="test-metrics-more-host" ref={morePopoverHostRef}>
                    <button
                      type="button"
                      ref={moreButtonRef}
                      className={`test-metrics-more-button${selectedExtraMetricId ? " selected" : ""}`}
                      aria-haspopup="dialog"
                      aria-expanded={moreOpen}
                      onClick={() => {
                        setMoreOpen((current) => !current);
                        setCompactSelectOpen(null);
                        setTestSelectorOpen(false);
                        setMetricSearch("");
                      }}
                    >
                      <Activity size={15} aria-hidden="true" />
                      <span>{selectedExtraMetricId ? config.label : "More"}</span>
                      <ChevronDown size={14} aria-hidden="true" />
                    </button>

                    {moreOpen && typeof document !== "undefined" ? createPortal(
                      <div
                        className="test-metrics-more-popover"
                        ref={morePopoverRef}
                        role="dialog"
                        aria-label="More metrics"
                        style={{
                          top: morePopoverLayout?.top ?? 0,
                          left: morePopoverLayout?.left ?? 0,
                          width: morePopoverLayout?.width ?? MORE_POPOVER_MAX_WIDTH,
                          visibility: morePopoverLayout ? "visible" : "hidden"
                        }}
                      >
                        <div className="filter-popover-header">
                          <strong>More metrics</strong>
                        </div>
                        <div className="filter-popover-body test-metrics-more-body">
                          <div className="filter-categories test-metrics-more-groups">
                            {moreMetricGroups.map((group) => (
                              <button
                                key={group.id}
                                type="button"
                                className={group.id === activeMetricGroup?.id ? "selected" : ""}
                                onClick={() => {
                                  setActiveMetricGroupId(group.id);
                                  setMetricSearch("");
                                }}
                              >
                                <span>{group.label}</span>
                                <strong>{group.metrics.length}</strong>
                              </button>
                            ))}
                          </div>

                          <div className="filter-options">
                            <label className="filter-option-search">
                              <Search size={15} aria-hidden="true" />
                              <input
                                value={metricSearch}
                                onChange={(event) => setMetricSearch(event.target.value)}
                                placeholder="Search metrics"
                              />
                            </label>

                            <div className="filter-option-list test-metrics-more-list">
                              {visibleMoreMetrics.map((metric) => {
                                const MetricIcon = metricIcons[metric.id] ?? Activity;
                                const isAvailable = metricAvailability.get(metric.id) ?? false;
                                const isSelected = metric.id === activeMetricId;
                                const unitLabel = metricUnit(activePackage, metric.id);
                                return (
                                  <button
                                    key={metric.id}
                                    type="button"
                                    className={`test-metrics-more-option${isSelected ? " selected" : ""}`}
                                    disabled={!isAvailable}
                                    onClick={() => selectMetric(metric)}
                                  >
                                    <MetricIcon size={16} aria-hidden="true" />
                                    <span className="test-metrics-more-name">
                                      <strong>{metric.label}</strong>
                                      {unitLabel ? <small>{unitLabel}</small> : null}
                                    </span>
                                    {!isAvailable ? <span className="metric-availability-badge">No data</span> : null}
                                  </button>
                                );
                              })}
                              {visibleMoreMetrics.length === 0 ? (
                                <p className="filter-empty">No metrics</p>
                              ) : null}
                            </div>
                          </div>
                        </div>
                      </div>
                      , document.body
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>

            <div className="test-metrics-workbar-right">
              {canUseStackedArea ? (
                <div className="test-metrics-chart-mode test-metrics-workbar-right" role="group" aria-label="Chart mode">
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
          </div>
          <div className="test-metrics-workbar-row" >
            <div className="test-metrics-filter-field test-metrics-filter-test" ref={testSelectorHostRef}>
              <span className="test-metrics-filter-label">
                <ListFilter size={15} aria-hidden="true" />
                Test
              </span>
              <button
                type="button"
                ref={testSelectorButtonRef}
                className="test-metrics-test-select-button"
                aria-haspopup="dialog"
                aria-expanded={testSelectorOpen}
                disabled={testOptions.length === 0}
                onClick={() => {
                  setMoreOpen(false);
                  setCompactSelectOpen(null);
                  setTestSelectorOpen((current) => {
                    if (!current) setTestSearch("");
                    return !current;
                  });
                }}
              >
                <span>{selectedTestLabel}</span>
                <ChevronDown size={14} aria-hidden="true" />
              </button>
            </div>


            <div className="test-metrics-workbar-right">
              <div className="test-metrics-filter-field test-metrics-filter-compact" ref={statSelectHostRef}>
                <span className="test-metrics-filter-label">
                  <Sigma size={15} aria-hidden="true" />
                  Stat
                </span>
                <button
                  type="button"
                  ref={statSelectButtonRef}
                  className="test-metrics-compact-select-button"
                  aria-haspopup="listbox"
                  aria-expanded={compactSelectOpen === "stat"}
                  onClick={() => {
                    setMoreOpen(false);
                    setTestSelectorOpen(false);
                    setCompactSelectOpen((current) => current === "stat" ? null : "stat");
                  }}
                >
                  <span>{stat}</span>
                  <ChevronDown size={14} aria-hidden="true" />
                </button>
              </div>

              {config.scopeType === "topology" ? (
                <div className="test-metrics-filter-field test-metrics-filter-compact" ref={scopeSelectHostRef}>
                  <span className="test-metrics-filter-label">
                    <Layers size={15} aria-hidden="true" />
                    Topology level
                  </span>
                  <button
                    type="button"
                    ref={scopeSelectButtonRef}
                    className="test-metrics-compact-select-button"
                    aria-haspopup="listbox"
                    aria-expanded={compactSelectOpen === "scope"}
                    onClick={() => {
                      setMoreOpen(false);
                      setTestSelectorOpen(false);
                      setCompactSelectOpen((current) => current === "scope" ? null : "scope");
                    }}
                  >
                    <span>{scope}</span>
                    <ChevronDown size={14} aria-hidden="true" />
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </section>

      {testSelectorOpen && typeof document !== "undefined" ? createPortal(
        <div
          className="test-metrics-test-popover"
          ref={testSelectorPopoverRef}
          role="dialog"
          aria-label="Select test"
          style={{
            top: testPopoverLayout?.top ?? 0,
            left: testPopoverLayout?.left ?? 0,
            width: testPopoverLayout?.width ?? TEST_POPOVER_MAX_WIDTH,
            maxHeight: testPopoverLayout?.maxHeight ?? undefined,
            visibility: testPopoverLayout ? "visible" : "hidden"
          }}
        >
          <div className="filter-popover-header">
            <strong>Select test</strong>
            <span className="test-metrics-test-count">
              {filteredTestOptions.length} of {testOptions.length}
            </span>
          </div>
          <div className="test-metrics-test-popover-body">
            <div className="test-metrics-test-popover-tools">
              <label className="filter-option-search test-metrics-test-search">
                <Search size={15} aria-hidden="true" />
                <input
                  value={testSearch}
                  onChange={(event) => setTestSearch(event.target.value)}
                  placeholder="Search tests"
                  autoFocus
                />
              </label>
              <div className="test-metrics-test-grouping">
                <span className="test-metrics-test-grouping-label">
                  <Layers size={13} aria-hidden="true" />
                  Group by
                </span>
                <div className="test-metrics-test-group-control" role="group" aria-label="Group tests">
                  {TEST_GROUP_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className={option.value === testGroupBy ? "selected" : ""}
                      aria-pressed={option.value === testGroupBy}
                      onClick={() => setTestGroupBy(option.value)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="test-metrics-test-list">
              {groupedTestOptions.map((group) => (
                <section
                  key={group.key}
                  className={`test-metrics-test-group${testGroupBy === "none" ? " ungrouped" : ""}`}
                >
                  {testGroupBy !== "none" ? (
                    <div className="test-metrics-test-group-header">
                      <span className="test-metrics-test-group-type">
                        <Layers size={12} aria-hidden="true" />
                        {testGroupingLabel(testGroupBy)}
                      </span>
                      <strong>{group.label}</strong>
                      <span className="test-metrics-test-group-count">{group.options.length}</span>
                    </div>
                  ) : null}
                  <div className="test-metrics-test-group-options">
                    {group.options.map((test) => {
                      const selected = test.key === selectedTestKey;
                      return (
                        <button
                          key={test.key}
                          type="button"
                          className={`test-metrics-test-option${selected ? " selected" : ""}`}
                          onClick={() => selectTestOption(test)}
                        >
                          <span className="test-metrics-test-option-copy">
                            <strong>{testOptionLabelForGroup(test, testGroupBy)}</strong>
                            <small>{testRunCountLabel(test.runCount)}</small>
                          </span>
                          {selected ? <Check size={15} aria-hidden="true" /> : null}
                        </button>
                      );
                    })}
                  </div>
                </section>
              ))}
              {filteredTestOptions.length === 0 ? <p className="filter-empty">No tests</p> : null}
            </div>
          </div>
        </div>,
        document.body
      ) : null}

      {compactSelectOpen && typeof document !== "undefined" ? createPortal(
        <div
          className="test-metrics-compact-popover"
          ref={compactSelectPopoverRef}
          role="listbox"
          aria-label={compactSelectOpen === "stat" ? "Stat" : "Topology level"}
          style={{
            top: compactSelectLayout?.top ?? 0,
            left: compactSelectLayout?.left ?? 0,
            width: compactSelectLayout?.width ?? COMPACT_POPOVER_MIN_WIDTH,
            visibility: compactSelectLayout ? "visible" : "hidden"
          }}
        >
          {compactSelectOptions.map((item) => {
            const selected = item === compactSelectValue;
            return (
              <button
                key={item}
                type="button"
                role="option"
                aria-selected={selected}
                className={`test-metrics-compact-option${selected ? " selected" : ""}`}
                onClick={() => selectCompactOption(item)}
              >
                <span>{item}</span>
                {selected ? <Check size={15} aria-hidden="true" /> : null}
              </button>
            );
          })}
        </div>,
        document.body
      ) : null}

      <section className="panel chart-panel">
        <EChartsReact
          key={chartKey}
          option={chartOption}
          onEvents={chartEvents}
          notMerge={false}
          lazyUpdate
          style={{ height: 460, width: "100%" }}
        />
        {rows.length === 0 ? <div className="chart-empty-state">No Data</div> : null}
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
