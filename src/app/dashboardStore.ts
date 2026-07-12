export interface DashboardChart {
  id: string;
  identityKey: string;
  title: string;
  subtitle: string;
  packageId: string;
  packageName: string;
  rowCount: number;
  createdAt: string;
  option: Record<string, unknown>;
  tooltip?: DashboardTooltipConfig;
}

export interface DashboardTooltipConfig {
  unit: string;
  chartMode: "line" | "stackedArea";
  scopeType: "raw" | "topology";
  isAdditiveMetric: boolean;
  topologyNodes: Record<string, { color?: string; symbol?: string }>;
}

export interface NewDashboardChart {
  identityKey: string;
  title: string;
  subtitle: string;
  packageId: string;
  packageName: string;
  rowCount: number;
  option: unknown;
  tooltip?: DashboardTooltipConfig;
}

const DASHBOARD_STORAGE_KEY = "perfexa.dashboardCharts.v1";
const DASHBOARD_CHANNEL = "perfexa-dashboard";

function makeChartId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `chart-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function createChannel(): BroadcastChannel | undefined {
  return typeof BroadcastChannel === "undefined" ? undefined : new BroadcastChannel(DASHBOARD_CHANNEL);
}

function sanitizeOption(option: unknown): Record<string, unknown> {
  try {
    const serialized = JSON.stringify(option, (_key, value) =>
      typeof value === "function" ? undefined : value
    );
    const parsed = JSON.parse(serialized);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function persistCharts(charts: DashboardChart[]): void {
  localStorage.setItem(DASHBOARD_STORAGE_KEY, JSON.stringify(charts));
}

function notifyDashboardChanged(): void {
  const channel = createChannel();
  channel?.postMessage({ type: "dashboard-changed" });
  channel?.close();
}

export function listDashboardCharts(): DashboardChart[] {
  try {
    const raw = localStorage.getItem(DASHBOARD_STORAGE_KEY);
    if (!raw) return [];

    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.map(normalizeDashboardChart).filter((chart): chart is DashboardChart => Boolean(chart))
      : [];
  } catch {
    return [];
  }
}

export function hasDashboardChart(identityKey: string): boolean {
  return listDashboardCharts().some((chart) => chart.identityKey === identityKey);
}

export function addDashboardChart(chart: NewDashboardChart): { chart: DashboardChart; added: boolean } {
  const charts = listDashboardCharts();
  const existingChart = charts.find((item) => item.identityKey === chart.identityKey);
  if (existingChart) {
    return { chart: existingChart, added: false };
  }

  const nextChart: DashboardChart = {
    ...chart,
    id: makeChartId(),
    createdAt: new Date().toISOString(),
    option: sanitizeOption(chart.option)
  };
  persistCharts([nextChart, ...charts]);
  notifyDashboardChanged();
  return { chart: nextChart, added: true };
}

export function removeDashboardChart(id: string): void {
  persistCharts(listDashboardCharts().filter((chart) => chart.id !== id));
  notifyDashboardChanged();
}

export function clearDashboardCharts(): void {
  persistCharts([]);
  notifyDashboardChanged();
}

export function subscribeDashboardCharts(callback: () => void): () => void {
  const channel = createChannel();
  const handleStorage = (event: StorageEvent) => {
    if (event.key === DASHBOARD_STORAGE_KEY) callback();
  };
  const handleMessage = () => callback();

  window.addEventListener("storage", handleStorage);
  channel?.addEventListener("message", handleMessage);

  return () => {
    window.removeEventListener("storage", handleStorage);
    channel?.removeEventListener("message", handleMessage);
    channel?.close();
  };
}

function normalizeDashboardChart(value: unknown): DashboardChart | undefined {
  if (!isDashboardChartLike(value)) return undefined;
  const chart = value as Omit<DashboardChart, "identityKey"> & { identityKey?: string };
  return {
    ...chart,
    identityKey: typeof chart.identityKey === "string" ? chart.identityKey : `${chart.packageId}:${chart.title}:${chart.subtitle}`
  };
}

function isDashboardChartLike(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const chart = value as Partial<DashboardChart>;
  return (
    typeof chart.id === "string" &&
    typeof chart.title === "string" &&
    typeof chart.subtitle === "string" &&
    typeof chart.packageId === "string" &&
    typeof chart.packageName === "string" &&
    typeof chart.rowCount === "number" &&
    typeof chart.createdAt === "string" &&
    Boolean(chart.option) &&
    typeof chart.option === "object" &&
    !Array.isArray(chart.option)
  );
}
