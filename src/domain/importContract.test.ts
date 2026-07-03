import { readFile, stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { validateImportSource } from "./importContract";
import { evaluateSaturationForRun } from "./saturation";
import { resolveTopologyMeasurements } from "./topologyMetrics";
import type { ImportFileSource } from "./types";

const validFiles: Record<string, string> = {
  "manifest.yaml": `
schemaVersion: 1
components:
  kafka:
    label: Kafka
    kind: infrastructure
`,
  "metrics.yaml": `
metrics:
  latency:
    aggregation: max
    unit: ms
    description: Latency.
  throughput:
    aggregation: sum
    unit: tps
    description: Throughput.
  error_rate:
    aggregation: max
    unit: percent
    description: Error rate.
  cpu:
    aggregation: sum
    unit: mCPU
    description: CPU.
  memory:
    aggregation: sum
    unit: MB
    description: Memory.
  throttling:
    aggregation: max
    unit: percent
    description: Throttling.
`,
  "topology.yaml": `
unknownValues: strict
layers:
  - key: group
    symbol: square
  - key: pod
nodes:
  - key: kafka
    layer: group
    color: "#ff0043"
    children: [kafka-0, kafka-1]
`,
  "saturation.yaml": `
schemaVersion: 1
defaults:
  saturatedWhen:
    - metric_id: throttling
      stat: max
      operator: ">"
      value: 20
overrides: []
`,
  "notes.yaml": `
schemaVersion: 1
runs: []
comparisons: []
`,
  "runs.csv": `run_id,scenario_id,config_id,sequence_id,target_tps,started_at,duration
run-001,checkout,cfg-main,0,300,2026-06-20T09:00:00Z,30m
`,
  "tests.csv": `scenario_id,config_id,sequence_id
checkout,cfg-main,0
`,
  "configs.csv": `config_id,exagon_ver,components_ver
cfg-main,3.13.0,"kafka:3.7.0"
`,
  "scenarios.csv": `scenario_id,name
checkout,Checkout steady load
`,
  "measurements.csv": `run_id,metric_id,stat,instance_id,value
run-001,latency,p95,,31.4
run-001,throughput,effective,,299.4
run-001,error_rate,avg,,0.02
run-001,cpu,avg,kafka-0,10
run-001,cpu,avg,kafka-1,20
run-001,memory,avg,kafka-0,100
run-001,memory,avg,kafka-1,200
run-001,throttling,max,kafka-0,10
run-001,throttling,max,kafka-1,30
`
};

function source(files: Record<string, string>): ImportFileSource {
  return {
    rootName: "test-import",
    readText: async (relativePath) => {
      const text = files[relativePath];
      if (text === undefined) throw new Error("missing");
      return text;
    },
    hasDirectory: async (relativePath) => relativePath === "raw"
  };
}

function fixtureSource(rootName: string): ImportFileSource {
  return {
    rootName,
    readText: async (relativePath) =>
      readFile(new URL(`../../fixtures/${rootName}/${relativePath}`, import.meta.url), "utf8"),
    hasDirectory: async (relativePath) => {
      try {
        return (await stat(new URL(`../../fixtures/${rootName}/${relativePath}`, import.meta.url))).isDirectory();
      } catch {
        return false;
      }
    }
  };
}

describe("import contract", () => {
  it("accepts a valid run-observation import", async () => {
    const result = await validateImportSource(source(validFiles));

    expect(result.report.valid).toBe(true);
    expect(result.package?.runs).toHaveLength(1);
    expect(result.report.features.find((feature) => feature.featureId === "overview")?.status).toBe(
      "available"
    );
  });

  it("accepts the sample fixture", async () => {
    const result = await validateImportSource(fixtureSource("perf-import"));

    expect(result.report.valid).toBe(true);
    expect(result.package?.configs).toHaveLength(2);
  });

  it("accepts the real performance fixture", async () => {
    const result = await validateImportSource(fixtureSource("real-perf-import"));

    expect(result.report.valid).toBe(true);
    expect(result.package?.runs).toHaveLength(66);
    expect(result.package?.configs).toHaveLength(3);
  });

  it("accepts stored group measurements as topology constraints", async () => {
    const result = await validateImportSource(
      source({
        ...validFiles,
        "measurements.csv": `${validFiles["measurements.csv"]}run-001,cpu,avg,kafka,30\n`
      })
    );

    expect(result.report.valid).toBe(true);
  });

  it("rejects stored group measurements that conflict with child observations", async () => {
    const result = await validateImportSource(
      source({
        ...validFiles,
        "measurements.csv": `${validFiles["measurements.csv"]}run-001,cpu,avg,kafka,99\n`
      })
    );

    expect(result.report.valid).toBe(false);
    expect(result.report.errors.some((error) => error.message.includes("conflicts with its children"))).toBe(true);
  });

  it("rejects measurement metrics that are not declared in metrics.yaml", async () => {
    const result = await validateImportSource(
      source({
        ...validFiles,
        "measurements.csv": `${validFiles["measurements.csv"]}run-001,queue_depth,avg,kafka-0,5\n`
      })
    );

    expect(result.report.valid).toBe(false);
    expect(result.report.errors.some((error) => error.message.includes("queue_depth"))).toBe(true);
  });

  it("aggregates repeated run test reference errors by offending value", async () => {
    const result = await validateImportSource(
      source({
        ...validFiles,
        "runs.csv": `run_id,scenario_id,config_id,sequence_id,target_tps,started_at,duration
run-001,checkout,missing-config,0,300,2026-06-20T09:00:00Z,30m
run-002,checkout,missing-config,0,450,2026-06-20T10:00:00Z,30m
run-003,checkout,other-missing,0,600,2026-06-20T11:00:00Z,30m
`
      })
    );

    const unknownTestErrors = result.report.errors.filter((error) =>
      error.message.includes("Run references unknown test")
    );

    expect(unknownTestErrors).toHaveLength(2);
    expect(unknownTestErrors).toContainEqual({
      severity: "error",
      file: "runs.csv",
      message: 'Run references unknown test "checkout / missing-config / #0" in 2 rows.'
    });
  });

  it("requires tests to reference a declared scenario_id", async () => {
    const result = await validateImportSource(
      source({
        ...validFiles,
        "tests.csv": `scenario_id,config_id,sequence_id
missing-scenario,cfg-main,0
`
      })
    );

    expect(result.report.valid).toBe(false);
    expect(result.report.errors).toContainEqual({
      severity: "error",
      file: "tests.csv",
      message: 'Test references unknown scenario_id "missing-scenario" in 1 row.'
    });
  });

  it("requires tests to reference a declared config_id", async () => {
    const result = await validateImportSource(
      source({
        ...validFiles,
        "tests.csv": `scenario_id,config_id,sequence_id
checkout,missing-config,0
`
      })
    );

    expect(result.report.valid).toBe(false);
    expect(result.report.errors).toContainEqual({
      severity: "error",
      file: "tests.csv",
      message: 'Test references unknown config_id "missing-config" in 1 row.'
    });
  });

  it("derives topology group values without storing them in measurements", async () => {
    const result = await validateImportSource(source(validFiles));
    const pkg = result.package!;
    const groups = resolveTopologyMeasurements(pkg.topology, pkg.metrics, pkg.measurements, "cpu", "avg", "group").projected;

    expect(groups).toContainEqual({
      run_id: "run-001",
      metric_id: "cpu",
      stat: "avg",
      instance_id: "kafka",
      value: 30,
      topology_level: "group",
      topology_level_index: 0,
      source: "derived"
    });
  });

  it("evaluates saturation from rules", async () => {
    const result = await validateImportSource(source(validFiles));
    const pkg = result.package!;
    const evaluation = evaluateSaturationForRun(pkg, pkg.runs[0]);

    expect(evaluation.saturated).toBe(true);
    expect(evaluation.source).toBe("rule");
  });
});
