import { describe, expect, it } from "vitest";
import type { ImportedPackage } from "../domain/types";
import { isCurrentPackage } from "./database";

function currentPackage(): ImportedPackage {
  return {
    id: "current",
    name: "Current package",
    importedAt: "2026-07-02T12:00:00Z",
    manifest: { schemaVersion: 1, components: {} },
    metrics: {
      favorites: [],
      groups: {},
      metrics: {
        cpu: { topology: { aggregation: "sum" }, unit: "mCPU" },
        throttling: { topology: { aggregation: "max" }, unit: "percent" }
      }
    },
    topology: {
      unknownValues: "strict",
      layers: [{ key: "group", symbol: "square" }, { key: "pod" }],
      nodes: [
        { key: "rf", layer: "group", color: "#ff0043", children: ["rf-a-0", "rf-b-0"] },
        { key: "im", layer: "group", color: null, children: [] }
      ]
    },
    saturation: {
      schemaVersion: 1,
      defaults: {
        saturatedWhen: [{ metric_id: "throttling", stat: "max", operator: ">", value: 80 }]
      },
      overrides: []
    },
    notes: { schemaVersion: 1, runs: [], comparisons: [] },
    scenarios: [{ scenario_id: "s1", name: "Scenario" }],
    configs: [{ config_id: "c1", exagon_ver: "6.2.0", components_ver: "" }],
    tests: [{ scenario_id: "s1", config_id: "c1" }],
    runs: [
      {
        run_id: "r1",
        scenario_id: "s1",
        config_id: "c1",
        sequence_id: 0,
        target_tps: 100,
        started_at: "2026-07-02T12:00:00Z",
        duration: "10m"
      }
    ],
    measurements: [
      { run_id: "r1", metric_id: "cpu", stat: "avg", instance_id: "rf-a-0", value: 10 },
      { run_id: "r1", metric_id: "cpu", stat: "avg", instance_id: "rf-b-0", value: 20 }
    ],
    validationReport: { valid: true, errors: [], warnings: [], features: [] }
  };
}

describe("stored package shape", () => {
  it("accepts current packages without normalization", () => {
    expect(isCurrentPackage(currentPackage())).toBe(true);
  });

  it("rejects legacy packages instead of adapting them", () => {
    const legacy = currentPackage() as unknown as Record<string, unknown>;
    legacy.metrics = { metrics: { cpu: { unit: "mCPU" } } };
    legacy.topology = { schemaVersion: 1, groups: { rf: { members: ["rf-a-0", "rf-b-0"] } } };
    legacy.measurements = [
      { run_id: "r1", metric_id: "cpu", stat: "avg", instance_type: "pod", instance_id: "rf-a-0", value: 10 }
    ];

    expect(isCurrentPackage(legacy)).toBe(false);
  });
});
