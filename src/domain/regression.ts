import { evaluateSaturationByRun } from "./saturation";
import { scenarioName, testKeyFor } from "./selectors";
import type { ImportedPackage, MeasurementRecord, RunRecord, TestRecord } from "./types";

export interface RegressionPoint {
  effectiveTps: number;
  cpuMcpu: number;
}

export interface HyperbolicFit {
  idle: number;
  marginalCpu: number;
  transientOverhead: number;
  halfSaturationK: number;
  rSquared: number;
  rmse: number;
}

export interface CpuRegressionRow {
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

interface RegressionGroup {
  testKey: string;
  scenarioId: string;
  scenario: string;
  configId: string;
  sequenceId: number;
  exagonVersion: string;
  fittedPoints: RegressionPoint[];
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
      measurement.instance_type === "run" &&
      Number.isFinite(measurement.value)
    ) {
      result.set(measurement.run_id, measurement.value);
    }
  }

  return result;
}

function buildCpuByRun(measurements: MeasurementRecord[]): Map<string, number> {
  const podSums = new Map<string, number>();
  const runValues = new Map<string, number>();

  for (const measurement of measurements) {
    if (measurement.metric_id !== "cpu" || measurement.stat !== "avg" || !Number.isFinite(measurement.value)) {
      continue;
    }

    if (measurement.instance_type === "pod") {
      podSums.set(measurement.run_id, (podSums.get(measurement.run_id) ?? 0) + measurement.value);
    } else if (measurement.instance_type === "run") {
      runValues.set(measurement.run_id, measurement.value);
    }
  }

  return new Map([...runValues, ...podSums]);
}

function createGroup(pkg: ImportedPackage, test: TestRecord | RunRecord): RegressionGroup {
  const config = pkg.configs.find((entry) => entry.config_id === test.config_id);

  return {
    testKey: testKeyFor(test),
    scenarioId: test.scenario_id,
    scenario: scenarioName(pkg, test.scenario_id),
    configId: test.config_id,
    sequenceId: test.sequence_id,
    exagonVersion: config?.exagon_ver ?? test.config_id,
    fittedPoints: [],
    totalPoints: 0
  };
}

export function buildCpuRegressionRows(pkg: ImportedPackage): CpuRegressionRow[] {
  const groups = new Map<string, RegressionGroup>();
  const effectiveTpsByRun = buildEffectiveTpsByRun(pkg.measurements);
  const cpuByRun = buildCpuByRun(pkg.measurements);
  const saturationByRun = evaluateSaturationByRun(pkg);

  for (const test of pkg.tests) {
    groups.set(testKeyFor(test), createGroup(pkg, test));
  }

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
    if (!saturationByRun[run.run_id]?.saturated) {
      group.fittedPoints.push({ effectiveTps, cpuMcpu });
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
        totalPoints: group.totalPoints
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

export function calculateHyperbolicFit(points: RegressionPoint[]): HyperbolicFit | null {
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

function hasTpsVariation(points: RegressionPoint[]): boolean {
  const first = points[0].effectiveTps;
  return points.some((point) => Math.abs(point.effectiveTps - first) > 1e-9);
}

function calculateKBounds(points: RegressionPoint[]): { minK: number; maxK: number } | null {
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
  points: RegressionPoint[],
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

function evaluateForK(points: RegressionPoint[], k: number): FitEvaluation | null {
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

function solveLinearLeastSquaresForK(points: RegressionPoint[], k: number): number[] | null {
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

function predictCpu(
  effectiveTps: number,
  idle: number,
  marginalCpu: number,
  transientOverhead: number,
  halfSaturationK: number
): number {
  return idle + marginalCpu * effectiveTps + (transientOverhead * effectiveTps) / (halfSaturationK + effectiveTps);
}
