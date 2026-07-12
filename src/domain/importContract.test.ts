import { readFile, readdir, stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { validateImportSource } from "./importContract";
import { evaluateSaturationForRun } from "./saturation";
import { resolveTopologyMeasurements } from "./topologyMetrics";
import type { ImportFileSource } from "./types";

type TestFileMap = Record<string, string | Uint8Array>;

const validFiles: TestFileMap = {
  "manifest.yaml": `
schemaVersion: 1
components:
  kafka:
    label: Kafka
    kind: infrastructure
`,
  "metrics.yaml": `
latency:
  unit: ms
  description: Latency.
throughput:
  unit: tps
  description: Throughput.
error_rate:
  unit: percent
  description: Error rate.
cpu:
  unit: mCPU
  description: CPU.
  topology:
    aggregation: sum
memory:
  unit: MB
  description: Memory.
  topology:
    aggregation: sum
throttling:
  unit: percent
  description: Throttling.
  topology:
    aggregation: max
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
  "tests.csv": `scenario_id,config_id
checkout,cfg-main
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

function source(files: TestFileMap): ImportFileSource {
  return {
    rootName: "test-import",
    readText: async (relativePath) => {
      const value = files[relativePath];
      if (typeof value !== "string") throw new Error("missing");
      return value;
    },
    readBytes: async (relativePath) => {
      const value = files[relativePath];
      if (value === undefined) throw new Error("missing");
      if (typeof value === "string") return new TextEncoder().encode(value);
      return value;
    },
    listFiles: async () => Object.keys(files),
    hasDirectory: async (relativePath) => relativePath === "raw"
  };
}

function fixtureSource(rootName: string, options: { listFiles?: boolean } = {}): ImportFileSource {
  return {
    rootName,
    readText: async (relativePath) =>
      readFile(new URL(`../../fixtures/${rootName}/${relativePath}`, import.meta.url), "utf8"),
    readBytes: async (relativePath) =>
      new Uint8Array(await readFile(new URL(`../../fixtures/${rootName}/${relativePath}`, import.meta.url))),
    ...(options.listFiles
      ? {
          listFiles: async () => {
            const entries = await readdir(new URL(`../../fixtures/${rootName}/`, import.meta.url), {
              withFileTypes: true
            });
            return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
          }
        }
      : {}),
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
    expect(result.package?.scenarioHelp).toBeUndefined();
    expect(result.report.features.find((feature) => feature.featureId === "run-explorer")?.status).toBe(
      "available"
    );
  });

  it("accepts split CSV fragments that end with the canonical table name", async () => {
    const result = await validateImportSource(
      source({
        ...validFiles,
        "extra.configs.csv": `config_id,exagon_ver,components_ver
cfg-extra,3.14.0,"kafka:3.8.0"
`,
        "extra.tests.csv": `scenario_id,config_id
checkout,cfg-extra
`,
        "part2.runs.csv": `run_id,scenario_id,config_id,sequence_id,target_tps,started_at,duration
run-002,checkout,cfg-extra,1,450,2026-06-20T10:00:00Z,30m
`,
        "raw/debug.runs.csv": `run_id,scenario_id,config_id,sequence_id,target_tps,started_at,duration
run-raw,checkout,cfg-extra,2,500,2026-06-20T11:00:00Z,30m
`
      })
    );

    expect(result.report.valid).toBe(true);
    expect(result.package?.runs.map((run) => run.run_id)).toEqual(["run-001", "run-002"]);
    expect(result.package?.configs.map((config) => config.config_id)).toEqual(["cfg-main", "cfg-extra"]);
    expect(result.package?.tests.map((test) => `${test.scenario_id}/${test.config_id}`)).toEqual([
      "checkout/cfg-main",
      "checkout/cfg-extra"
    ]);
  });

  it("reports split CSV parse issues against the fragment file", async () => {
    const result = await validateImportSource(
      source({
        ...validFiles,
        "bad.runs.csv": `run_id,scenario_id
run-002,checkout
`
      })
    );

    expect(result.report.valid).toBe(false);
    expect(result.report.errors).toContainEqual({
      severity: "error",
      file: "bad.runs.csv",
      message: 'Missing required column "config_id".'
    });
  });

  it("reports topology measurement failures against the originating fragment", async () => {
    const result = await validateImportSource(
      source({
        ...validFiles,
        "topology.yaml": `
unknownValues: strict
layers:
  - key: microservice
  - key: application
nodes:
  - key: usrv-a
    layer: microservice
    children: [orch-a, redis-a]
  - key: orch-a
    layer: application
  - key: redis-a
    layer: application
`,
        "measurements.csv": `run_id,metric_id,stat,instance_id,value
`,
        "problem.measurements.csv": `run_id,metric_id,stat,instance_id,value
run-001,throttling,max,orch-a,0
`
      })
    );

    expect(result.report.valid).toBe(false);
    expect(result.report.errors).toContainEqual(
      expect.objectContaining({
        severity: "error",
        file: "problem.measurements.csv",
        path: "problem.measurements.csv:2"
      })
    );
    expect(result.report.errors[0].message).toContain('run "run-001"');
    expect(result.report.errors[0].message).toContain("problem.measurements.csv:2");
    expect(result.report.errors[0].message).toContain("run-001,throttling,max,redis-a,<value>");
  });

  it("accepts additional metric definitions from metrics YAML", async () => {
    const result = await validateImportSource(
      source({
        ...validFiles,
        "metrics.yaml": `${validFiles["metrics.yaml"]}queue_depth:
  unit: count
  description: Queue depth.
  topology:
    aggregation: max
`,
        "measurements.csv": `${validFiles["measurements.csv"]}run-001,queue_depth,max,,5\n`
      })
    );

    expect(result.report.valid).toBe(true);
    expect(result.package?.metrics.metrics.queue_depth).toEqual({
      unit: "count",
      description: "Queue depth.",
      topology: { aggregation: "max" }
    });
  });

  it("accepts metric favorites and source groups from metrics YAML", async () => {
    const result = await validateImportSource(
      source({
        ...validFiles,
        "metrics.yaml": `
favorites: [latency, cpu]
groups:
  oms:
    name: OMS
  os:
    name: OS
metrics:
  latency:
    unit: ms
    description: Latency.
    group: oms
  throughput:
    unit: tps
    description: Throughput.
    group: oms
  error_rate:
    unit: percent
    description: Error rate.
    group: oms
  cpu:
    unit: mCPU
    description: CPU.
    group: os
    topology:
      aggregation: sum
  memory:
    unit: MB
    description: Memory.
    group: os
    topology:
      aggregation: sum
  throttling:
    unit: percent
    description: Throttling.
    group: null
    topology:
      aggregation: max
`
      })
    );

    expect(result.report.valid).toBe(true);
    expect(result.package?.metrics.favorites).toEqual(["latency", "cpu"]);
    expect(result.package?.metrics.groups.os).toEqual({ name: "OS" });
    expect(result.package?.metrics.metrics.cpu.group).toBe("os");
    expect(result.package?.metrics.metrics.throttling.group).toBeNull();
  });

  it("rejects metric favorites and groups that reference unknown ids", async () => {
    const result = await validateImportSource(
      source({
        ...validFiles,
        "metrics.yaml": `
favorites: [latency, missing_metric]
groups:
  oms:
    name: OMS
metrics:
  latency:
    unit: ms
  throughput:
    unit: tps
  error_rate:
    unit: percent
  cpu:
    unit: mCPU
    group: os
    topology:
      aggregation: sum
  memory:
    unit: MB
    topology:
      aggregation: sum
  throttling:
    unit: percent
    topology:
      aggregation: max
`
      })
    );

    expect(result.report.valid).toBe(false);
    expect(result.report.errors.some((error) => error.message.includes('favorite "missing_metric"'))).toBe(true);
    expect(result.report.errors.some((error) => error.message.includes('unknown metric group "os"'))).toBe(true);
  });

  it("accepts valid scenario help with categories and an image", async () => {
    const result = await validateImportSource(
      source({
        ...validFiles,
        "scenario-help.yaml": `
schemaVersion: 1
scenarios:
  checkout:
    title: Checkout steady load
    body: |
      Descricao geral do cenario.
    microservices:
      - 1 orchestrator
      - 2 participants
    sagas:
      - 1 orchestrated from network
    activities:
      - 2 internal orchestrated
    blOperations:
      - 1 RW save
    images:
      - path: help/images/checkout-flow.png
        caption: Checkout flow
`,
        "help/images/checkout-flow.png": new Uint8Array([137, 80, 78, 71])
      })
    );

    expect(result.report.valid).toBe(true);
    expect(result.package?.scenarioHelp?.scenarios.checkout.microservices).toEqual([
      "1 orchestrator",
      "2 participants"
    ]);
    expect(result.package?.scenarioHelp?.scenarios.checkout.images[0]).toMatchObject({
      path: "help/images/checkout-flow.png",
      caption: "Checkout flow",
      mimeType: "image/png",
      dataUrl: "data:image/png;base64,iVBORw=="
    });
  });

  it("rejects scenario help that references an unknown scenario_id", async () => {
    const result = await validateImportSource(
      source({
        ...validFiles,
        "scenario-help.yaml": `
schemaVersion: 1
scenarios:
  missing-scenario:
    title: Missing
`
      })
    );

    expect(result.report.valid).toBe(false);
    expect(result.report.errors.some((error) => error.message.includes('unknown scenario_id "missing-scenario"'))).toBe(
      true
    );
  });

  it("rejects scenario help with invalid structure", async () => {
    const result = await validateImportSource(
      source({
        ...validFiles,
        "scenario-help.yaml": `
schemaVersion: 2
scenarios: []
`
      })
    );

    expect(result.report.valid).toBe(false);
    expect(result.report.errors.some((error) => error.file === "scenario-help.yaml")).toBe(true);
  });

  it("rejects scenario help with a missing image path", async () => {
    const result = await validateImportSource(
      source({
        ...validFiles,
        "scenario-help.yaml": `
schemaVersion: 1
scenarios:
  checkout:
    title: Checkout
    images:
      - path: help/images/missing.png
`
      })
    );

    expect(result.report.valid).toBe(false);
    expect(result.report.errors.some((error) => error.message.includes("help/images/missing.png"))).toBe(true);
  });

  it("accepts the sample fixture", async () => {
    const result = await validateImportSource(fixtureSource("perf-import"));

    expect(result.report.valid).toBe(true);
    expect(result.package?.configs).toHaveLength(2);
  });

  it("accepts the real performance fixture", async () => {
    const result = await validateImportSource(fixtureSource("real-perf-import"));

    expect(result.report.valid).toBe(true);
    expect(result.package?.runs).toHaveLength(81);
    expect(result.package?.configs).toHaveLength(5);
  });

  it("accepts the real performance fixture with split root CSV fragments", async () => {
    const result = await validateImportSource(fixtureSource("real-perf-import", { listFiles: true }));

    expect(result.report.errors).toEqual([]);
    expect(result.report.valid).toBe(true);
    expect(result.package?.runs.length).toBeGreaterThan(81);
    expect(result.package?.measurements.some((measurement) => measurement.run_id === "202607081428")).toBe(true);
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

  it("aggregates repeated run config reference errors by offending value", async () => {
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

    const unknownConfigErrors = result.report.errors.filter((error) =>
      error.message.includes("Run references unknown config_id")
    );

    expect(unknownConfigErrors).toHaveLength(2);
    expect(unknownConfigErrors).toContainEqual({
      severity: "error",
      file: "runs.csv",
      message: 'Run references unknown config_id "missing-config" in 2 rows.'
    });
  });

  it("requires tests to reference a declared scenario_id", async () => {
    const result = await validateImportSource(
      source({
        ...validFiles,
        "tests.csv": `scenario_id,config_id
missing-scenario,cfg-main
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
        "tests.csv": `scenario_id,config_id
checkout,missing-config
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
