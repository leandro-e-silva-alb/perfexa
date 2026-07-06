import { describe, expect, it } from "vitest";
import { buildCoverageMatrix, measurementsForScope, testKeyFor } from "./selectors";
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
      layers: [{ key: "application", symbol: "triangle" }, { key: "instance" }],
      nodes: [{ key: "mongo-a", layer: "application", color: "red", children: ["mongo-a-0", "mongo-a-1"] }]
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

describe("coverage selectors", () => {
  it("builds a scenario/config execution matrix from planned tests and runs", () => {
    const data: ImportedPackage = {
      ...pkg([]),
      scenarios: [
        { scenario_id: "checkout", name: "Checkout" },
        { scenario_id: "browse", name: "Browse" }
      ],
      configs: [
        { config_id: "cfg-a", exagon_ver: "1.0.0", components_ver: "" },
        { config_id: "cfg-b", exagon_ver: "2.0.0", components_ver: "" },
        { config_id: "cfg-c", exagon_ver: "3.0.0", components_ver: "" }
      ],
      tests: [
        { scenario_id: "checkout", config_id: "cfg-a", sequence_id: 0 },
        { scenario_id: "checkout", config_id: "cfg-b", sequence_id: 0 },
        { scenario_id: "browse", config_id: "cfg-b", sequence_id: 0 }
      ],
      runs: [
        {
          run_id: "run-1",
          scenario_id: "checkout",
          config_id: "cfg-a",
          sequence_id: 0,
          target_tps: 100,
          started_at: "2026-07-02T12:00:00Z",
          duration: "10m"
        },
        {
          run_id: "run-2",
          scenario_id: "checkout",
          config_id: "cfg-a",
          sequence_id: 1,
          target_tps: 200,
          started_at: "2026-07-02T12:10:00Z",
          duration: "10m"
        },
        {
          run_id: "run-3",
          scenario_id: "browse",
          config_id: "cfg-c",
          sequence_id: 0,
          target_tps: 300,
          started_at: "2026-07-02T12:20:00Z",
          duration: "10m"
        }
      ]
    };

    const matrix = buildCoverageMatrix(data);
    const checkout = matrix.rows.find((row) => row.scenario_id === "checkout")!;
    const browse = matrix.rows.find((row) => row.scenario_id === "browse")!;

    expect(matrix.configs.map((config) => config.config_id)).toEqual(["cfg-a", "cfg-b", "cfg-c"]);
    expect(Object.fromEntries(checkout.cells.map((cell) => [cell.config_id, cell.value]))).toEqual({
      "cfg-a": 2,
      "cfg-b": 0,
      "cfg-c": "-"
    });
    expect(Object.fromEntries(browse.cells.map((cell) => [cell.config_id, cell.value]))).toEqual({
      "cfg-a": "-",
      "cfg-b": 0,
      "cfg-c": "-"
    });
    expect(matrix.plannedPairs).toBe(3);
    expect(matrix.coveredPairs).toBe(1);
    expect(matrix.pendingPairs).toBe(2);
    expect(matrix.unplannedRuns).toBe(1);
  });
});
