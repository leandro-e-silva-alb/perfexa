import { resolveTopologyMeasurements } from "./topologyMetrics";
import type {
  ImportedPackage,
  MeasurementRecord,
  RunRecord,
  SaturationEvaluation,
  SaturationOperator,
  SaturationRule
} from "./types";

function compare(value: number, operator: SaturationOperator, threshold: number): boolean {
  if (operator === ">") return value > threshold;
  if (operator === ">=") return value >= threshold;
  if (operator === "<") return value < threshold;
  if (operator === "<=") return value <= threshold;
  if (operator === "!=") return value !== threshold;
  return value === threshold;
}

function describeRule(rule: SaturationRule): string {
  const instance = rule.instance_id ? ` ${rule.instance_id}` : "";
  return `${rule.metric_id}/${rule.stat}${instance} ${rule.operator} ${rule.value}`;
}

function matchingMeasurements(rule: SaturationRule, run: RunRecord, measurements: MeasurementRecord[]) {
  return measurements.filter(
    (measurement) =>
      measurement.run_id === run.run_id &&
      measurement.metric_id === rule.metric_id &&
      measurement.stat === rule.stat &&
      (!rule.instance_id || measurement.instance_id === rule.instance_id)
  );
}

function projectedMeasurementsForRules(pkg: ImportedPackage): MeasurementRecord[] {
  const targets = new Map(
    pkg.saturation.defaults.saturatedWhen.map((rule) => [`${rule.metric_id}|${rule.stat}`, rule])
  );

  return [...targets.values()].flatMap((rule) =>
    pkg.metrics.metrics[rule.metric_id]?.topology
      ? resolveTopologyMeasurements(pkg.topology, pkg.metrics, pkg.measurements, rule.metric_id, rule.stat).projected
      : []
  );
}

export function evaluateSaturationForRun(pkg: ImportedPackage, run: RunRecord): SaturationEvaluation {
  const override = pkg.saturation.overrides.find((item) => item.run_id === run.run_id);
  if (override) {
    return {
      run_id: run.run_id,
      saturated: override.saturated,
      source: "override",
      reason: override.reason || "Manual override",
      matchedRules: []
    };
  }

  const measurements = [...pkg.measurements, ...projectedMeasurementsForRules(pkg)];

  const matchedRules = pkg.saturation.defaults.saturatedWhen.filter((rule) =>
    matchingMeasurements(rule, run, measurements).some((measurement) =>
      compare(measurement.value, rule.operator, rule.value)
    )
  );

  if (matchedRules.length > 0) {
    return {
      run_id: run.run_id,
      saturated: true,
      source: "rule",
      reason: matchedRules.map(describeRule).join("; "),
      matchedRules: matchedRules.map(describeRule)
    };
  }

  return {
    run_id: run.run_id,
    saturated: false,
    source: "none",
    reason: "No saturation rule matched",
    matchedRules: []
  };
}

export function evaluateSaturationByRun(pkg: ImportedPackage): Record<string, SaturationEvaluation> {
  return Object.fromEntries(
    pkg.runs.map((run) => [run.run_id, evaluateSaturationForRun(pkg, run)])
  );
}
