import { deriveGroupMeasurements } from "./aggregation";
import { evaluateSaturationForRun } from "./saturation";
import type { ConfigRecord, ImportedPackage, MeasurementRecord, RunRecord, SaturationEvaluation, TestRecord } from "./types";

export interface RunSummary {
  run_id: string;
  test_key: string;
  test_name: string;
  scenario_id: string;
  scenario_name: string;
  config_id: string;
  sequence_id: number;
  target_tps: number;
  started_at: string;
  duration: string;
  exagon_ver: string;
  components_ver: string;
  versions: string;
  effective_tps?: number;
  latency_avg?: number;
  latency_p95?: number;
  error_rate?: number;
  saturation: SaturationEvaluation;
}

export interface MetricPoint extends MeasurementRecord {
  test_key: string;
  test_name: string;
  scenario_id: string;
  scenario_name: string;
  config_id: string;
  sequence_id: number;
  target_tps: number;
  effective_tps: number;
  unit: string;
}

export function formatNumber(value: number | undefined, digits = 2): string {
  if (value === undefined || Number.isNaN(value)) return "-";
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: digits
  }).format(value);
}

export function metricUnit(pkg: ImportedPackage, metricId: string): string {
  const unit = pkg.metrics.metrics[metricId]?.unit ?? "";
  return unit.toLowerCase() === "percent" ? "%" : unit;
}

export function formatDateTime(value: string | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  })
    .format(date)
    .replace("24:", "00:");
}

export function scenarioName(pkg: ImportedPackage, scenarioId: string): string {
  return pkg.scenarios.find((scenario) => scenario.scenario_id === scenarioId)?.name ?? scenarioId;
}

export function testForRun(pkg: ImportedPackage, run: RunRecord | undefined): TestRecord | undefined {
  if (!run) return undefined;
  return pkg.tests.find(
    (test) =>
      test.scenario_id === run.scenario_id &&
      test.config_id === run.config_id &&
      test.sequence_id === run.sequence_id
  );
}

export function configForRun(pkg: ImportedPackage, run: RunRecord | undefined): ConfigRecord | undefined {
  if (!run) return undefined;
  return pkg.configs.find((config) => config.config_id === run.config_id);
}

export function testKeyFor(item: Pick<RunRecord, "scenario_id" | "config_id" | "sequence_id">): string {
  return `${item.scenario_id} / ${item.config_id} / #${item.sequence_id}`;
}

export function testNameFor(
  pkg: ImportedPackage,
  item: Pick<RunRecord, "scenario_id" | "config_id" | "sequence_id">
): string {
  const config = pkg.configs.find((entry) => entry.config_id === item.config_id)!;
  return `${scenarioName(pkg, item.scenario_id)} \u00bb ${config.exagon_ver} \u00bb #${item.sequence_id}`;
  return `${scenarioName(pkg, item.scenario_id)} » ${config.exagon_ver} » #${item.sequence_id}`;
  return `${scenarioName(pkg, item.scenario_id)} • ${config.exagon_ver} – #${item.sequence_id}`;
}

export function findMeasurement(
  measurements: MeasurementRecord[],
  runId: string,
  metricId: string,
  stat: string,
  instanceType: string,
  instanceId = ""
): number | undefined {
  return measurements.find(
    (measurement) =>
      measurement.run_id === runId &&
      measurement.metric_id === metricId &&
      measurement.stat === stat &&
      measurement.instance_type === instanceType &&
      measurement.instance_id === instanceId
  )?.value;
}

export function componentVersionSummary(pkg: ImportedPackage, componentsVer: string): string {
  const entries = componentsVer
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const separatorIndex = item.indexOf(":");
      if (separatorIndex === -1) return { component_id: item, version: "" };
      return {
        component_id: item.slice(0, separatorIndex).trim(),
        version: item.slice(separatorIndex + 1).trim()
      };
    });

  const preferred = entries.filter((component) =>
    ["usrv-a", "usrv-b", "usrv-c", "im", "kafka", "redis", "mongo"].includes(component.component_id)
  );
  const selected = preferred.length > 0 ? preferred : entries.slice(0, 7);

  return selected
    .map((component) => {
      const label = pkg.manifest.components[component.component_id]?.label ?? component.component_id;
      return component.version ? `${label} ${component.version}` : label;
    })
    .join(", ");
}

export function buildRunSummary(pkg: ImportedPackage, run: RunRecord): RunSummary {
  const test = testForRun(pkg, run);
  const config = configForRun(pkg, run)!;
  const scenarioId = test?.scenario_id ?? run.scenario_id;
  const configId = test?.config_id ?? run.config_id;
  const sequenceId = test?.sequence_id ?? run.sequence_id;
  const componentsVer = config.components_ver;
  const scenarioDisplayName = scenarioName(pkg, scenarioId);
  const exagonVer = config.exagon_ver;

  return {
    run_id: run.run_id,
    test_key: testKeyFor({ scenario_id: scenarioId, config_id: configId, sequence_id: sequenceId }),
    test_name: testNameFor(pkg, { scenario_id: scenarioId, config_id: configId, sequence_id: sequenceId }),
    scenario_id: scenarioId,
    scenario_name: scenarioDisplayName,
    config_id: configId,
    sequence_id: sequenceId,
    target_tps: run.target_tps,
    started_at: run.started_at,
    duration: run.duration,
    exagon_ver: exagonVer,
    components_ver: componentsVer,
    versions: componentVersionSummary(pkg, componentsVer),
    effective_tps: findMeasurement(pkg.measurements, run.run_id, "throughput", "effective", "run"),
    latency_avg: findMeasurement(pkg.measurements, run.run_id, "latency", "avg", "run"),
    latency_p95: findMeasurement(pkg.measurements, run.run_id, "latency", "p95", "run"),
    error_rate: findMeasurement(pkg.measurements, run.run_id, "error_rate", "avg", "run"),
    saturation: evaluateSaturationForRun(pkg, run)
  };
}

export function buildRunSummaries(pkg: ImportedPackage): RunSummary[] {
  return [...pkg.runs]
    .sort((a, b) => a.target_tps - b.target_tps || a.started_at.localeCompare(b.started_at))
    .map((run) => buildRunSummary(pkg, run));
}

export function measurementsForScope(
  pkg: ImportedPackage,
  metricId: string,
  stat: string,
  scope: "run" | "pod" | "group"
): MetricPoint[] {
  const source =
    scope === "group"
      ? deriveGroupMeasurements(pkg.topology, pkg.measurements, metricId, stat)
      : pkg.measurements;

  return source
    .filter(
      (measurement) =>
        measurement.metric_id === metricId &&
        measurement.stat === stat &&
        measurement.instance_type === scope
    )
    .map((measurement) => {
      const run = pkg.runs.find((item) => item.run_id === measurement.run_id);
      const test = testForRun(pkg, run);
      const scenarioId = test?.scenario_id ?? run?.scenario_id ?? "";
      const effectiveTps =
        run ? findMeasurement(pkg.measurements, run.run_id, "throughput", "effective", "run") : undefined;
      return {
        ...measurement,
        test_key: run ? testKeyFor(run) : "",
        test_name: run ? testNameFor(pkg, run) : "",
        scenario_id: scenarioId,
        scenario_name: scenarioId ? scenarioName(pkg, scenarioId) : "",
        config_id: run?.config_id ?? "",
        sequence_id: run?.sequence_id ?? 0,
        target_tps: run?.target_tps ?? 0,
        effective_tps: effectiveTps ?? run?.target_tps ?? 0,
        unit: metricUnit(pkg, metricId)
      };
    })
    .sort(
      (a, b) =>
        a.effective_tps - b.effective_tps ||
        a.instance_id.localeCompare(b.instance_id) ||
        a.run_id.localeCompare(b.run_id)
    );
}
