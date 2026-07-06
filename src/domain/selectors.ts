import { evaluateSaturationForRun } from "./saturation";
import { buildTopologyGraph, resolveTopologyMeasurements, type ProjectedMeasurement, type TopologyGraph } from "./topologyMetrics";
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
  scope: string;
  source?: "observed" | "derived" | "rogue";
}

export interface CoverageMatrixCell {
  scenario_id: string;
  config_id: string;
  planned: boolean;
  runCount: number;
  value: "-" | number;
}

export interface CoverageMatrixRow {
  scenario_id: string;
  scenario_name: string;
  cells: CoverageMatrixCell[];
}

export interface CoverageMatrixConfig {
  config_id: string;
  label: string;
}

export interface CoverageMatrix {
  configs: CoverageMatrixConfig[];
  rows: CoverageMatrixRow[];
  plannedPairs: number;
  coveredPairs: number;
  pendingPairs: number;
  unplannedRuns: number;
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

function pairKey(scenarioId: string, configId: string): string {
  return `${scenarioId}\u0000${configId}`;
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
  instanceId = ""
): number | undefined {
  return measurements.find(
    (measurement) =>
      measurement.run_id === runId &&
      measurement.metric_id === metricId &&
      measurement.stat === stat &&
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

export function buildCoverageMatrix(pkg: ImportedPackage): CoverageMatrix {
  const scenarioEntries = new Map(pkg.scenarios.map((scenario) => [scenario.scenario_id, scenario]));
  const configEntries = new Map(pkg.configs.map((config) => [config.config_id, config]));
  const scenarioIds = new Set(pkg.scenarios.map((scenario) => scenario.scenario_id));
  const configIds = new Set(pkg.configs.map((config) => config.config_id));

  for (const test of pkg.tests) {
    scenarioIds.add(test.scenario_id);
    configIds.add(test.config_id);
  }

  for (const run of pkg.runs) {
    scenarioIds.add(run.scenario_id);
    configIds.add(run.config_id);
  }

  const plannedPairs = new Set(pkg.tests.map((test) => pairKey(test.scenario_id, test.config_id)));
  const runCounts = new Map<string, number>();

  for (const run of pkg.runs) {
    const key = pairKey(run.scenario_id, run.config_id);
    runCounts.set(key, (runCounts.get(key) ?? 0) + 1);
  }

  let coveredPairs = 0;
  let pendingPairs = 0;

  for (const key of plannedPairs) {
    if ((runCounts.get(key) ?? 0) > 0) {
      coveredPairs += 1;
    } else {
      pendingPairs += 1;
    }
  }

  const unplannedRuns = pkg.runs.filter((run) => !plannedPairs.has(pairKey(run.scenario_id, run.config_id))).length;
  const orderedScenarioIds = [...scenarioIds].sort((left, right) => {
    const leftName = scenarioEntries.get(left)?.name ?? left;
    const rightName = scenarioEntries.get(right)?.name ?? right;
    return leftName.localeCompare(rightName, undefined, { numeric: true });
  });
  const orderedConfigIds = [...configIds].sort((left, right) => {
    const leftConfig = configEntries.get(left);
    const rightConfig = configEntries.get(right);
    const leftLabel = leftConfig?.exagon_ver ?? left;
    const rightLabel = rightConfig?.exagon_ver ?? right;
    return leftLabel.localeCompare(rightLabel, undefined, { numeric: true });
  });

  const configs = orderedConfigIds.map((configId) => {
    const config = configEntries.get(configId);
    return {
      config_id: configId,
      label: config?.exagon_ver ?? configId
    };
  });

  const rows = orderedScenarioIds.map((scenarioId) => ({
    scenario_id: scenarioId,
    scenario_name: scenarioEntries.get(scenarioId)?.name ?? scenarioId,
    cells: orderedConfigIds.map((configId) => {
      const key = pairKey(scenarioId, configId);
      const planned = plannedPairs.has(key);
      const runCount = runCounts.get(key) ?? 0;

      return {
        scenario_id: scenarioId,
        config_id: configId,
        planned,
        runCount,
        value: planned ? runCount : ("-" as const)
      };
    })
  }));

  return {
    configs,
    rows,
    plannedPairs: plannedPairs.size,
    coveredPairs,
    pendingPairs,
    unplannedRuns
  };
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
    effective_tps: findMeasurement(pkg.measurements, run.run_id, "throughput", "effective"),
    latency_avg: findMeasurement(pkg.measurements, run.run_id, "latency", "avg"),
    latency_p95: findMeasurement(pkg.measurements, run.run_id, "latency", "p95"),
    error_rate: findMeasurement(pkg.measurements, run.run_id, "error_rate", "avg"),
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
  scope: string,
  selectedTestKey?: string
): MetricPoint[] {
  const source = scope === "run"
    ? pkg.measurements.filter((measurement) => measurement.instance_id === "")
    : topologyMeasurementsForTest(pkg, metricId, stat, scope, selectedTestKey);

  return source
    .filter(
      (measurement) =>
        measurement.metric_id === metricId &&
        measurement.stat === stat
    )
    .map((measurement) => {
      const run = pkg.runs.find((item) => item.run_id === measurement.run_id);
      const test = testForRun(pkg, run);
      const scenarioId = test?.scenario_id ?? run?.scenario_id ?? "";
      const effectiveTps =
        run ? findMeasurement(pkg.measurements, run.run_id, "throughput", "effective") : undefined;
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
        unit: metricUnit(pkg, metricId),
        scope
      };
    })
    .sort(
      (a, b) =>
        a.effective_tps - b.effective_tps ||
        a.instance_id.localeCompare(b.instance_id) ||
        a.run_id.localeCompare(b.run_id)
    );
}

function topologyMeasurementsForTest(
  pkg: ImportedPackage,
  metricId: string,
  stat: string,
  scope: string,
  selectedTestKey?: string
): ProjectedMeasurement[] {
  const graph = buildTopologyGraph(pkg.topology);
  const targetLevelIndex = graph.levels.indexOf(scope);
  if (targetLevelIndex < 0 || !selectedTestKey) {
    return resolveTopologyMeasurements(pkg.topology, pkg.metrics, pkg.measurements, metricId, stat, scope).projected;
  }

  const selectedRunIds = new Set(
    pkg.runs
      .filter((run) => testKeyFor(run) === selectedTestKey)
      .map((run) => run.run_id)
  );
  const allProjected = resolveTopologyMeasurements(pkg.topology, pkg.metrics, pkg.measurements, metricId, stat).projected
    .filter((measurement) => selectedRunIds.has(measurement.run_id));
  const targetProjected = allProjected.filter((measurement) => measurement.topology_level === scope);
  const collapseAncestors = collapseAncestorsForTest(graph, targetProjected, targetLevelIndex);

  if (collapseAncestors.size === 0) {
    return targetProjected;
  }

  const byRunAndId = new Map(allProjected.map((measurement) => [`${measurement.run_id}|${measurement.instance_id}`, measurement]));
  const collapsed: ProjectedMeasurement[] = [];
  const emitted = new Set<string>();

  for (const measurement of targetProjected) {
    const ancestorId = matchingCollapseAncestor(graph, measurement.instance_id, collapseAncestors);
    if (!ancestorId) {
      const key = `${measurement.run_id}|${measurement.instance_id}`;
      if (!emitted.has(key)) {
        collapsed.push(measurement);
        emitted.add(key);
      }
      continue;
    }

    const ancestorMeasurement = byRunAndId.get(`${measurement.run_id}|${ancestorId}`);
    if (!ancestorMeasurement) continue;

    const key = `${ancestorMeasurement.run_id}|${ancestorMeasurement.instance_id}`;
    if (!emitted.has(key)) {
      collapsed.push({
        ...ancestorMeasurement,
        topology_level: scope,
        topology_level_index: targetLevelIndex
      });
      emitted.add(key);
    }
  }

  return collapsed;
}

function collapseAncestorsForTest(
  graph: TopologyGraph,
  targetProjected: ProjectedMeasurement[],
  targetLevelIndex: number
): Set<string> {
  const ancestors = new Set<string>();

  for (const measurement of targetProjected) {
    const node = graph.nodes.get(measurement.instance_id);
    if (node && node.levelIndex < targetLevelIndex) {
      ancestors.add(node.id);
    }
  }

  for (const ancestorId of [...ancestors]) {
    if (hasAncestorInSet(graph, ancestorId, ancestors)) {
      ancestors.delete(ancestorId);
    }
  }

  return ancestors;
}

function hasAncestorInSet(graph: TopologyGraph, nodeId: string, ids: Set<string>): boolean {
  let parentId = graph.nodes.get(nodeId)?.parent;
  while (parentId) {
    if (ids.has(parentId)) return true;
    parentId = graph.nodes.get(parentId)?.parent;
  }
  return false;
}

function matchingCollapseAncestor(graph: TopologyGraph, nodeId: string, ids: Set<string>): string | undefined {
  if (ids.has(nodeId)) return nodeId;

  let parentId = graph.nodes.get(nodeId)?.parent;
  while (parentId) {
    if (ids.has(parentId)) return parentId;
    parentId = graph.nodes.get(parentId)?.parent;
  }

  return undefined;
}
