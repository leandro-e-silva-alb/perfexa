import { describe, expect, it } from "vitest";
import { measurementsForScope, testKeyFor } from "./selectors";
import type { ImportedPackage, MeasurementRecord } from "./types";

function measurement(
  runId: string,
  metricId: string,
  stat: string,
  instanceId: string,
  value: number
): MeasurementRecord {
  return { run_id: runId, metric_id: metricId, stat, instance_id: instanceId, value };
}

function pkg(measurements: MeasurementRecord[]): ImportedPackage {
  return {
    id: "pkg",
    name: "Package",
    importedAt: "2026-07-02T12:00:00Z",
    manifest: { schemaVersion: 1, components: {} },
    metrics: {
      metrics: {
        cpu: { aggregation: "sum", unit: "mCPU" },
        throughput: { aggregation: "sum", unit: "tps" }
      }
    },
    topology: {
      unknownValues: "strict",
      levels: ["application", "instance"],
      topology: { application: { "mongo-a": ["mongo-a-0", "mongo-a-1"] } },
      standalone: {}
    },
    saturation: { schemaVersion: 1, defaults: { saturatedWhen: [] }, overrides: [] },
    notes: { schemaVersion: 1, runs: [], comparisons: [] },
    scenarios: [{ scenario_id: "scenario", name: "Scenario" }],
    configs: [{ config_id: "config", exagon_ver: "6.3.0", components_ver: "" }],
    tests: [{ scenario_id: "scenario", config_id: "config", sequence_id: 0 }],
    runs: [
      {
        run_id: "run-1",
        scenario_id: "scenario",
        config_id: "config",
        sequence_id: 0,
        target_tps: 100,
        started_at: "2026-07-02T12:00:00Z",
        duration: "10m"
      },
      {
        run_id: "run-2",
        scenario_id: "scenario",
        config_id: "config",
        sequence_id: 0,
        target_tps: 200,
        started_at: "2026-07-02T12:10:00Z",
        duration: "10m"
      }
    ],
    measurements,
    validationReport: { valid: true, errors: [], warnings: [], features: [] }
  };
}

describe("metric selectors", () => {
  it("uses a uniform ancestor projection for mixed granularity inside a test", () => {
    const data = pkg([
      measurement("run-1", "throughput", "effective", "", 100),
      measurement("run-1", "cpu", "avg", "mongo-a", 30),
      measurement("run-2", "throughput", "effective", "", 200),
      measurement("run-2", "cpu", "avg", "mongo-a", 30),
      measurement("run-2", "cpu", "avg", "mongo-a-0", 10)
    ]);

    const rows = measurementsForScope(data, "cpu", "avg", "instance", testKeyFor(data.runs[0]));

    expect(rows.map((row) => [row.run_id, row.instance_id, row.value])).toEqual([
      ["run-1", "mongo-a", 30],
      ["run-2", "mongo-a", 30]
    ]);
  });

  it("keeps instance projection when every run can resolve children", () => {
    const data = pkg([
      measurement("run-1", "throughput", "effective", "", 100),
      measurement("run-1", "cpu", "avg", "mongo-a", 30),
      measurement("run-1", "cpu", "avg", "mongo-a-0", 10),
      measurement("run-2", "throughput", "effective", "", 200),
      measurement("run-2", "cpu", "avg", "mongo-a", 60),
      measurement("run-2", "cpu", "avg", "mongo-a-0", 20)
    ]);

    const rows = measurementsForScope(data, "cpu", "avg", "instance", testKeyFor(data.runs[0]));

    expect(rows.map((row) => [row.run_id, row.instance_id, row.value])).toEqual([
      ["run-1", "mongo-a-0", 10],
      ["run-1", "mongo-a-1", 20],
      ["run-2", "mongo-a-0", 20],
      ["run-2", "mongo-a-1", 40]
    ]);
  });
});
