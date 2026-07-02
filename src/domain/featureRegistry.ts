import type {
  AppFeature,
  FeatureAvailability,
  FeatureRequirement,
  MeasurementRecord,
  RunRecord
} from "./types";

export const featureRegistry: AppFeature[] = [
  {
    id: "overview",
    label: "Overview table",
    description: "Operational run summary with TPS, latency, errors, versions, and saturation.",
    requirements: [
      { metric_id: "throughput", stat: "effective", instance_id: "", label: "Effective TPS" },
      { metric_id: "latency", stat: "p95", instance_id: "", label: "Latency p95" },
      { metric_id: "error_rate", stat: "avg", instance_id: "", label: "Error rate avg" }
    ]
  },
  {
    id: "run_charts",
    label: "Run charts",
    description: "Run-level charts over target TPS for throughput, latency, and errors.",
    requirements: [
      { metric_id: "throughput", stat: "effective", instance_id: "", label: "Effective TPS" },
      { metric_id: "latency", stat: "p95", instance_id: "", label: "Latency p95" },
      { metric_id: "error_rate", stat: "avg", instance_id: "", label: "Error rate avg" }
    ]
  },
  {
    id: "pod_resources",
    label: "Node resources",
    description: "Topology-attached CPU, memory, and throttling measurements.",
    requirements: [
      { metric_id: "cpu", stat: "avg", label: "CPU avg by node" },
      { metric_id: "memory", stat: "avg", label: "Memory avg by node" },
      { metric_id: "throttling", stat: "max", label: "Throttling max by node" }
    ]
  },
  {
    id: "regression",
    label: "Regression table",
    description: "CPU-over-TPS regression by test.",
    requirements: [
      { metric_id: "throughput", stat: "effective", instance_id: "", label: "Effective TPS" },
      { metric_id: "cpu", stat: "avg", label: "CPU avg by topology node" }
    ]
  },
  {
    id: "saturation",
    label: "Saturation evaluation",
    description: "Rule-based saturation checks and explicit overrides.",
    requirements: [
      { metric_id: "throttling", stat: "max", label: "Throttling max by node" }
    ]
  }
];

export function requirementKey(requirement: FeatureRequirement): string {
  return `${requirement.metric_id}/${requirement.stat}/${requirement.instance_id ?? "*"}`;
}

export function evaluateFeatureAvailability(
  runs: RunRecord[],
  measurements: MeasurementRecord[]
): FeatureAvailability[] {
  return featureRegistry.map((feature) => {
    const requiredCount = feature.requirements.length * Math.max(runs.length, 1);
    let presentCount = 0;
    const missing: string[] = [];

    for (const requirement of feature.requirements) {
      const presentRuns = runs.filter((run) =>
        measurements.some(
          (measurement) =>
            measurement.run_id === run.run_id &&
            measurement.metric_id === requirement.metric_id &&
            measurement.stat === requirement.stat &&
            (requirement.instance_id === undefined || measurement.instance_id === requirement.instance_id)
        )
      );

      presentCount += presentRuns.length;

      if (presentRuns.length < runs.length) {
        const missingRunIds = runs
          .filter((run) => !presentRuns.some((present) => present.run_id === run.run_id))
          .map((run) => run.run_id);
        missing.push(`${requirement.label}: ${missingRunIds.join(", ") || "all runs"}`);
      }
    }

    const status =
      presentCount === requiredCount && requiredCount > 0
        ? "available"
        : presentCount > 0
          ? "partial"
          : "unavailable";

    return {
      featureId: feature.id,
      label: feature.label,
      description: feature.description,
      status,
      presentCount,
      requiredCount,
      missing
    };
  });
}
