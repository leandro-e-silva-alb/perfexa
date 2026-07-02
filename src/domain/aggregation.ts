import type { AggregationMethod, MeasurementRecord, TopologyDocument } from "./types";

function aggregate(values: number[], method: AggregationMethod): number {
  if (method === "sum") return values.reduce((sum, value) => sum + value, 0);
  if (method === "avg") return values.reduce((sum, value) => sum + value, 0) / values.length;
  if (method === "min") return Math.min(...values);
  return Math.max(...values);
}

export function deriveGroupMeasurements(
  topology: TopologyDocument,
  measurements: MeasurementRecord[],
  metricFilter?: string,
  statFilter?: string
): MeasurementRecord[] {
  const podMeasurements = measurements.filter((measurement) => measurement.instance_type === "pod");
  const runIds = [...new Set(podMeasurements.map((measurement) => measurement.run_id))];
  const derived: MeasurementRecord[] = [];

  for (const [groupId, group] of Object.entries(topology.groups)) {
    for (const [metricId, method] of Object.entries(group.aggregations)) {
      if (metricFilter && metricId !== metricFilter) continue;

      const stats = [
        ...new Set(
          podMeasurements
            .filter(
              (measurement) =>
                measurement.metric_id === metricId &&
                group.members.includes(measurement.instance_id) &&
                (!statFilter || measurement.stat === statFilter)
            )
            .map((measurement) => measurement.stat)
        )
      ];

      for (const stat of stats) {
        for (const runId of runIds) {
          const values = podMeasurements
            .filter(
              (measurement) =>
                measurement.run_id === runId &&
                measurement.metric_id === metricId &&
                measurement.stat === stat &&
                group.members.includes(measurement.instance_id)
            )
            .map((measurement) => measurement.value);

          if (values.length === 0) continue;

          derived.push({
            run_id: runId,
            metric_id: metricId,
            stat,
            instance_type: "group",
            instance_id: groupId,
            value: aggregate(values, method)
          });
        }
      }
    }
  }

  return derived;
}
