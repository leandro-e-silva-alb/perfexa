import { describe, expect, it } from "vitest";
import { buildScenarioBoardMatrix, exagonPatchVersion, measurementsForScope, testKeyFor } from "./selectors";
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
    tests: [{ scenario_id: "scenario", config_id: "config" }],
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

describe("scenario board selectors", () => {
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
        { scenario_id: "checkout", config_id: "cfg-a" },
        { scenario_id: "checkout", config_id: "cfg-b" },
        { scenario_id: "browse", config_id: "cfg-b" }
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

    const matrix = buildScenarioBoardMatrix(data);
    const checkout = matrix.rows.find((row) => row.scenario_id === "checkout")!;
    const browse = matrix.rows.find((row) => row.scenario_id === "browse")!;

    expect(matrix.configs.map((config) => config.config_id)).toEqual(["cfg-c", "cfg-b", "cfg-a"]);
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

  it("groups configs by Exagon patch version", () => {
    const data: ImportedPackage = {
      ...pkg([]),
      configs: [
        {
          config_id: "cfg-cd4150b9",
          exagon_ver: "6.3.2-SNAPSHOT",
          components_ver: "usrv-a:3.13.0-rc547,usrv-b:3.13.0-rc152,usrv-c:3.13.0-rc94"
        },
        {
          config_id: "cfg-672fd4a2",
          exagon_ver: "dev-6.2.0-SNAPSHOT",
          components_ver: "usrv-a:3.12.0-rc506,usrv-b:3.12.0-rc112,usrv-c:3.12.0-rc52"
        },
        {
          config_id: "cfg-77476a3e",
          exagon_ver: "dev-6.3.0-SNAPSHOT",
          components_ver: "usrv-a:3.13.0-rc528,usrv-b:3.13.0-rc133,usrv-c:3.13.0-rc73"
        },
        {
          config_id: "cfg-e8c9c6d6",
          exagon_ver: "dev-6.3.0-SNAPSHOT",
          components_ver: "usrv-a:3.13.0-rc523,usrv-b:3.13.0-rc127,usrv-c:3.13.0-rc67"
        }
      ],
      tests: [
        { scenario_id: "scenario", config_id: "cfg-cd4150b9" },
        { scenario_id: "scenario", config_id: "cfg-672fd4a2" },
        { scenario_id: "scenario", config_id: "cfg-77476a3e" },
        { scenario_id: "scenario", config_id: "cfg-e8c9c6d6" }
      ],
      runs: []
    };

    const matrix = buildScenarioBoardMatrix(data);

    expect(exagonPatchVersion("6.3.1")).toBe("6.3.1");
    expect(exagonPatchVersion("6.3.2-SNAPSHOT")).toBe("6.3.2");
    expect(exagonPatchVersion("dev-6.2.0-SNAPSHOT")).toBe("6.2.0");
    expect(matrix.configs.map((config) => [config.config_id, config.label, config.versionPatch, config.rcSummary])).toEqual([
      ["cfg-cd4150b9", "6.3.2-SNAPSHOT", "6.3.2", "rc547 / rc152 / rc94"],
      ["cfg-77476a3e", "dev-6.3.0-SNAPSHOT", "6.3.0", "rc528 / rc133 / rc73"],
      ["cfg-e8c9c6d6", "dev-6.3.0-SNAPSHOT", "6.3.0", "rc523 / rc127 / rc67"],
      ["cfg-672fd4a2", "dev-6.2.0-SNAPSHOT", "6.2.0", "rc506 / rc112 / rc52"]
    ]);
    expect(matrix.configGroups).toEqual([
      { versionPatch: "6.3.2", colSpan: 1 },
      { versionPatch: "6.3.0", colSpan: 2 },
      { versionPatch: "6.2.0", colSpan: 1 }
    ]);
  });
});
