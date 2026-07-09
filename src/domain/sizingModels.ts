import { evaluateSaturationByRun } from "./saturation";
import { scenarioName, testKeyFor } from "./selectors";
import { buildTopologyGraph, resolveTopologyMeasurements } from "./topologyMetrics";
import type { ImportedPackage, MeasurementRecord, RunRecord } from "./types";

export interface SizingModelPoint {
  effectiveTps: number;
  cpuMcpu: number;
}

export interface SizingModelChartPoint extends SizingModelPoint {
  runId: string;
  targetTps: number;
  fitted: boolean;
  saturated: boolean;
  latencyAvg?: number;
  maxThrottling?: number;
}

export interface HyperbolicFit {
  idle: number;
  marginalCpu: number;
  transientOverhead: number;
  halfSaturationK: number;
  rSquared: number;
  rmse: number;
}

export interface CpuSizingModelRow {
  testKey: string;
  scenarioId: string;
  scenario: string;
  configId: string;
  sequenceId: number;
  exagonVersion: string;
  idle: number | null;
  marginalCpu: number | null;
  transientOverhead: number | null;
  halfSaturationK: number | null;
  rSquared: number | null;
  rmse: number | null;
  fittedPoints: number;
  totalPoints: number;
}

export interface CpuSizingModelAnalysis extends CpuSizingModelRow {
  points: SizingModelChartPoint[];
}

interface SizingModelGroup {
  testKey: string;
  scenarioId: string;
  scenario: string;
  configId: string;
  sequenceId: number;
  exagonVersion: string;
  fittedPoints: SizingModelPoint[];
  points: SizingModelChartPoint[];
  totalPoints: number;
}

interface FitEvaluation {
  idle: number;
  marginalCpu: number;
  transientOverhead: number;
  halfSaturationK: number;
  sse: number;
  rmse: number;
}

const K_GRID_SIZE = 180;
const GOLDEN_SECTION_ITERATIONS = 48;
const SINGULARITY_TOLERANCE = 1e-10;

function isFiniteNumber(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value);
}

function buildEffectiveTpsByRun(measurements: MeasurementRecord[]): Map<string, number> {
  const result = new Map<string, number>();

  for (const measurement of measurements) {
    if (
      measurement.metric_id === "throughput" &&
      measurement.stat === "effective" &&
      measurement.instance_id === "" &&
      Number.isFinite(measurement.value)
    ) {
      result.set(measurement.run_id, measurement.value);
    }
  }

  return result;
}

function buildCpuByRun(pkg: ImportedPackage): Map<string, number> {
  const topLevel = buildTopologyGraph(pkg.topology).levels[0];
  if (!topLevel) {
    return new Map();
  }

  const projectedCpu = resolveTopologyMeasurements(pkg.topology, pkg.metrics, pkg.measurements, "cpu", "avg", topLevel).projected;
  const totals = new Map<string, number>();

  for (const measurement of projectedCpu) {
    if (Number.isFinite(measurement.value)) {
      totals.set(measurement.run_id, (totals.get(measurement.run_id) ?? 0) + measurement.value);
    }
  }

  return totals;
}

function buildRunLevelMeasurementByRun(
  measurements: MeasurementRecord[],
  metricId: string,
  stat: string
): Map<string, number> {
  const result = new Map<string, number>();

  for (const measurement of measurements) {
    if (
      measurement.metric_id === metricId &&
      measurement.stat === stat &&
      measurement.instance_id === "" &&
      Number.isFinite(measurement.value)
    ) {
      result.set(measurement.run_id, measurement.value);
    }
  }

  return result;
}

function buildMaxThrottlingByRun(pkg: ImportedPackage): Map<string, number> {
  const result = new Map<string, number>();
  const topLevel = buildTopologyGraph(pkg.topology).levels[0];
  const projected =
    topLevel && pkg.metrics.metrics.throttling
      ? resolveTopologyMeasurements(pkg.topology, pkg.metrics, pkg.measurements, "throttling", "max", topLevel).projected
      : [];
  const source =
    projected.length > 0
      ? projected
      : pkg.measurements.filter((measurement) => measurement.metric_id === "throttling" && measurement.stat === "max");

  for (const measurement of source) {
    if (!Number.isFinite(measurement.value)) {
      continue;
    }

    result.set(measurement.run_id, Math.max(result.get(measurement.run_id) ?? Number.NEGATIVE_INFINITY, measurement.value));
  }

  return result;
}

function createGroup(pkg: ImportedPackage, test: RunRecord): SizingModelGroup {
  const config = pkg.configs.find((entry) => entry.config_id === test.config_id);

  return {
    testKey: testKeyFor(test),
    scenarioId: test.scenario_id,
    scenario: scenarioName(pkg, test.scenario_id),
    configId: test.config_id,
    sequenceId: test.sequence_id,
    exagonVersion: config?.exagon_ver ?? test.config_id,
    fittedPoints: [],
    points: [],
    totalPoints: 0
  };
}

export function buildCpuSizingModelAnalyses(pkg: ImportedPackage): CpuSizingModelAnalysis[] {
  const groups = new Map<string, SizingModelGroup>();
  const effectiveTpsByRun = buildEffectiveTpsByRun(pkg.measurements);
  const cpuByRun = buildCpuByRun(pkg);
  const latencyAvgByRun = buildRunLevelMeasurementByRun(pkg.measurements, "latency", "avg");
  const maxThrottlingByRun = buildMaxThrottlingByRun(pkg);
  const saturationByRun = evaluateSaturationByRun(pkg);

  for (const run of pkg.runs) {
    const key = testKeyFor(run);
    const group = groups.get(key) ?? createGroup(pkg, run);
    groups.set(key, group);

    const effectiveTps = effectiveTpsByRun.get(run.run_id);
    const cpuMcpu = cpuByRun.get(run.run_id);
    if (!isFiniteNumber(effectiveTps) || effectiveTps < 0 || !isFiniteNumber(cpuMcpu)) {
      continue;
    }

    group.totalPoints += 1;
    const saturated = Boolean(saturationByRun[run.run_id]?.saturated);
    const point: SizingModelChartPoint = {
      runId: run.run_id,
      targetTps: run.target_tps,
      effectiveTps,
      cpuMcpu,
      fitted: !saturated,
      saturated,
      latencyAvg: latencyAvgByRun.get(run.run_id),
      maxThrottling: maxThrottlingByRun.get(run.run_id)
    };

    group.points.push(point);
    if (point.fitted) {
      group.fittedPoints.push(point);
    }
  }

  return [...groups.values()]
    .map((group) => {
      const fit = calculateHyperbolicFit(group.fittedPoints);
      return {
        testKey: group.testKey,
        scenarioId: group.scenarioId,
        scenario: group.scenario,
        configId: group.configId,
        sequenceId: group.sequenceId,
        exagonVersion: group.exagonVersion,
        idle: fit?.idle ?? null,
        marginalCpu: fit?.marginalCpu ?? null,
        transientOverhead: fit?.transientOverhead ?? null,
        halfSaturationK: fit?.halfSaturationK ?? null,
        rSquared: fit?.rSquared ?? null,
        rmse: fit?.rmse ?? null,
        fittedPoints: group.fittedPoints.length,
        totalPoints: group.totalPoints,
        points: group.points.sort(
          (left, right) => left.effectiveTps - right.effectiveTps || left.runId.localeCompare(right.runId)
        )
      };
    })
    .sort(
      (left, right) =>
        left.scenario.localeCompare(right.scenario, undefined, { numeric: true }) ||
        left.exagonVersion.localeCompare(right.exagonVersion, undefined, { numeric: true }) ||
        left.configId.localeCompare(right.configId, undefined, { numeric: true }) ||
        left.sequenceId - right.sequenceId
    );
}

export function buildCpuSizingModelRows(pkg: ImportedPackage): CpuSizingModelRow[] {
  return buildCpuSizingModelAnalyses(pkg).map(({ points, ...row }) => row);
}

export function calculateHyperbolicFit(points: SizingModelPoint[]): HyperbolicFit | null {
  if (points.length < 3 || !hasTpsVariation(points)) {
    return null;
  }

  const bounds = calculateKBounds(points);
  if (!bounds) {
    return null;
  }

  const logMinK = Math.log(bounds.minK);
  const logMaxK = Math.log(bounds.maxK);
  const gridStep = (logMaxK - logMinK) / (K_GRID_SIZE - 1);
  let best: FitEvaluation | null = null;
  let bestIndex = 0;

  for (let index = 0; index < K_GRID_SIZE; index += 1) {
    const k = Math.exp(logMinK + gridStep * index);
    const candidate = evaluateForK(points, k);
    if (candidate && (!best || candidate.sse < best.sse)) {
      best = candidate;
      bestIndex = index;
    }
  }

  if (!best) {
    return null;
  }

  const leftIndex = Math.max(0, bestIndex - 1);
  const rightIndex = Math.min(K_GRID_SIZE - 1, bestIndex + 1);
  let left = logMinK + gridStep * leftIndex;
  let right = logMinK + gridStep * rightIndex;

  if (left === right) {
    left = Math.max(logMinK, left - gridStep);
    right = Math.min(logMaxK, right + gridStep);
  }

  best = refineLogK(points, left, right, best) ?? best;

  const meanY = points.reduce((sum, point) => sum + point.cpuMcpu, 0) / points.length;
  const ssTotal = points.reduce((sum, point) => sum + (point.cpuMcpu - meanY) ** 2, 0);

  return {
    idle: best.idle,
    marginalCpu: best.marginalCpu,
    transientOverhead: best.transientOverhead,
    halfSaturationK: best.halfSaturationK,
    rSquared: ssTotal === 0 ? 1 : 1 - best.sse / ssTotal,
    rmse: best.rmse
  };
}

function hasTpsVariation(points: SizingModelPoint[]): boolean {
  const first = points[0].effectiveTps;
  return points.some((point) => Math.abs(point.effectiveTps - first) > 1e-9);
}

function calculateKBounds(points: SizingModelPoint[]): { minK: number; maxK: number } | null {
  const positiveTps = points.map((point) => point.effectiveTps).filter((value) => value > 0);
  if (positiveTps.length === 0) {
    return null;
  }

  const minPositiveTps = Math.min(...positiveTps);
  const maxTps = Math.max(...positiveTps);
  const minK = Math.max(minPositiveTps / 1000, 1e-9);
  const maxK = Math.max(maxTps * 1000, minK * 10);
  return { minK, maxK };
}

function refineLogK(
  points: SizingModelPoint[],
  left: number,
  right: number,
  initialBest: FitEvaluation
): FitEvaluation | null {
  const inversePhi = (Math.sqrt(5) - 1) / 2;
  let low = left;
  let high = right;
  let c = high - inversePhi * (high - low);
  let d = low + inversePhi * (high - low);
  let cFit = evaluateForK(points, Math.exp(c));
  let dFit = evaluateForK(points, Math.exp(d));
  let best = initialBest;

  for (let iteration = 0; iteration < GOLDEN_SECTION_ITERATIONS; iteration += 1) {
    if (cFit && cFit.sse < best.sse) {
      best = cFit;
    }
    if (dFit && dFit.sse < best.sse) {
      best = dFit;
    }

    const cScore = cFit ? cFit.sse : Number.POSITIVE_INFINITY;
    const dScore = dFit ? dFit.sse : Number.POSITIVE_INFINITY;

    if (cScore < dScore) {
      high = d;
      d = c;
      dFit = cFit;
      c = high - inversePhi * (high - low);
      cFit = evaluateForK(points, Math.exp(c));
    } else {
      low = c;
      c = d;
      cFit = dFit;
      d = low + inversePhi * (high - low);
      dFit = evaluateForK(points, Math.exp(d));
    }
  }

  return best;
}

function evaluateForK(points: SizingModelPoint[], k: number): FitEvaluation | null {
  const coefficients = solveLinearLeastSquaresForK(points, k);
  if (!coefficients) {
    return null;
  }

  const idle = coefficients[0];
  const marginalCpu = coefficients[1];
  const transientOverhead = coefficients[2];
  let sse = 0;

  for (const point of points) {
    const prediction = predictCpu(point.effectiveTps, idle, marginalCpu, transientOverhead, k);
    sse += (point.cpuMcpu - prediction) ** 2;
  }

  return {
    idle,
    marginalCpu,
    transientOverhead,
    halfSaturationK: k,
    sse,
    rmse: Math.sqrt(sse / points.length)
  };
}

function solveLinearLeastSquaresForK(points: SizingModelPoint[], k: number): number[] | null {
  const normal = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0]
  ];
  const rhs = [0, 0, 0];

  for (const point of points) {
    const x = point.effectiveTps;
    const h = x / (k + x);
    const columns = [1, x, h];

    for (let row = 0; row < 3; row += 1) {
      rhs[row] += columns[row] * point.cpuMcpu;
      for (let column = 0; column < 3; column += 1) {
        normal[row][column] += columns[row] * columns[column];
      }
    }
  }

  return solveLinearSystem(normal, rhs);
}

function solveLinearSystem(matrix: number[][], vector: number[]): number[] | null {
  const size = vector.length;
  const augmented = matrix.map((row, index) => [...row, vector[index]]);

  for (let pivotColumn = 0; pivotColumn < size; pivotColumn += 1) {
    let pivotRow = pivotColumn;
    let pivotAbs = Math.abs(augmented[pivotRow][pivotColumn]);

    for (let row = pivotColumn + 1; row < size; row += 1) {
      const candidateAbs = Math.abs(augmented[row][pivotColumn]);
      if (candidateAbs > pivotAbs) {
        pivotAbs = candidateAbs;
        pivotRow = row;
      }
    }

    if (pivotAbs < SINGULARITY_TOLERANCE) {
      return null;
    }

    if (pivotRow !== pivotColumn) {
      const temp = augmented[pivotColumn];
      augmented[pivotColumn] = augmented[pivotRow];
      augmented[pivotRow] = temp;
    }

    for (let row = pivotColumn + 1; row < size; row += 1) {
      const factor = augmented[row][pivotColumn] / augmented[pivotColumn][pivotColumn];
      for (let column = pivotColumn; column <= size; column += 1) {
        augmented[row][column] -= factor * augmented[pivotColumn][column];
      }
    }
  }

  const result = new Array<number>(size).fill(0);
  for (let row = size - 1; row >= 0; row -= 1) {
    let sum = augmented[row][size];
    for (let column = row + 1; column < size; column += 1) {
      sum -= augmented[row][column] * result[column];
    }
    result[row] = sum / augmented[row][row];
  }

  return result.every((value) => Number.isFinite(value)) ? result : null;
}

export function predictCpu(
  effectiveTps: number,
  idle: number,
  marginalCpu: number,
  transientOverhead: number,
  halfSaturationK: number
): number {
  return idle + marginalCpu * effectiveTps + (transientOverhead * effectiveTps) / (halfSaturationK + effectiveTps);
}
