import { describe, expect, it } from "vitest";
import { buildTopologyGraph, resolveTopologyMeasurements, validateMetricsDocument } from "./topologyMetrics";
import type { MeasurementRecord, MetricsDocument, TopologyDocument } from "./types";

const topology: TopologyDocument = {
  unknownValues: "permissive",
  layers: [
    { key: "continent", symbol: "square" },
    { key: "region", symbol: "triangle" },
    { key: "country" },
    { key: "city" }
  ],
  nodes: [
    { key: "america", layer: "continent", color: "#ff0043", children: ["north_america", "south_america"] },
    { key: "south_america", layer: "region", children: ["brazil", "venezuela"] },
    { key: "europe", layer: "region", children: ["portugal", "london", "paris"] },
    { key: "brazil", layer: "country", children: ["rio", "sao_paulo"] },
    { key: "portugal", layer: "country", children: ["lisbon", "porto"] },
    { key: "venezuela", layer: "country", children: ["caracas"] },
    { key: "atlantis", layer: "region", children: [] }
  ]
};

const metrics: MetricsDocument = {
  metrics: {
    wins: { aggregation: "ratio", weight: "matches" },
    matches: { aggregation: "sum" },
    city_max_wins: { aggregation: "max" },
    time_avg: { aggregation: "average", weight: "matches" },
    wins_per: { aggregation: "percentage", weight: "matches" },
    cpu: { aggregation: "sum", unit: "mCPU" }
  }
};

const observations: MeasurementRecord[] = [
  row("run-001", "wins", "avg", "america", 0.6666666667),
  row("run-001", "matches", "avg", "america", 30),
  row("run-001", "wins", "avg", "rio", 0.8),
  row("run-001", "matches", "avg", "rio", 5),
  row("run-001", "wins", "avg", "sao_paulo", 1),
  row("run-001", "matches", "avg", "sao_paulo", 4),
  row("run-001", "wins", "avg", "caracas", 0.5),
  row("run-001", "matches", "avg", "caracas", 10),
  row("run-001", "wins", "avg", "portugal", 0.6),
  row("run-001", "matches", "avg", "portugal", 10),
  row("run-001", "wins", "avg", "lisbon", 0.75),
  row("run-001", "matches", "avg", "lisbon", 4),
  row("run-001", "wins", "avg", "porto", 0.5),
  row("run-001", "matches", "avg", "porto", 6),
  row("run-001", "wins", "avg", "london", 0.8),
  row("run-001", "matches", "avg", "london", 10),
  row("run-001", "wins", "avg", "paris", 0.7),
  row("run-001", "matches", "avg", "paris", 10),
  row("run-001", "wins", "avg", "narnia", 0.9),
  row("run-001", "matches", "avg", "narnia", 10),
  row("run-001", "wins", "avg", "atlantis", 0.8),
  row("run-001", "matches", "avg", "atlantis", 10)
];

function row(runId: string, metricId: string, stat: string, instanceId: string, value: number): MeasurementRecord {
  return { run_id: runId, metric_id: metricId, stat, instance_id: instanceId, value };
}

describe("topology metric resolver", () => {
  it("validates topology shape", () => {
    expect(() =>
      buildTopologyGraph({
        unknownValues: "strict",
        layers: [{ key: "group" }, { key: "pod" }],
        nodes: [
          { key: "left", layer: "group", children: ["shared"] },
          { key: "right", layer: "group", children: ["shared"] }
        ]
      })
    ).toThrow(/belongs to both/);
  });

  it("exposes layer symbols and inherited color variants", () => {
    const graph = buildTopologyGraph(topology);

    expect(graph.nodes.get("america")?.symbol).toBe("rect");
    expect(graph.nodes.get("south_america")?.symbol).toBe("triangle");
    expect(graph.nodes.get("north_america")?.color).toBe("#990028");
    expect(graph.nodes.get("south_america")?.color).toBe("#ff668e");
  });

  it("validates metric definitions required for regression", () => {
    expect(validateMetricsDocument({ metrics: { cpu: { aggregation: "max" } } })).toContain(
      'metrics.yaml metric "cpu" must use aggregation "sum" for regression CPU totals.'
    );
    expect(validateMetricsDocument({ metrics: { matches: { aggregation: "sum" } } })).toContain(
      'metrics.yaml must define required metric "cpu" for regression.'
    );
  });

  it("projects weighted metrics while preserving hidden invariants", () => {
    const projected = resolveTopologyMeasurements(topology, metrics, observations, "wins", "avg").projected;
    const projectedMatches = resolveTopologyMeasurements(topology, metrics, observations, "matches", "avg").projected;

    for (const level of buildTopologyGraph(topology).levels) {
      const winsRows = projected.filter((item) => item.topology_level === level);
      const matchRows = projectedMatches.filter((item) => item.topology_level === level);
      const matchesById = new Map(matchRows.map((item) => [item.instance_id, item.value]));
      const hiddenWins = winsRows.reduce((sum, item) => sum + item.value * (matchesById.get(item.instance_id) ?? 0), 0);
      const totalMatches = matchRows.reduce((sum, item) => sum + item.value, 0);

      expect(totalMatches).toBeCloseTo(80, 6);
      expect(hiddenWins).toBeCloseTo(58, 6);
    }
  });

  it("rejects conflicting parent observations", () => {
    const changed = observations.map((measurement) =>
      measurement.metric_id === "wins" && measurement.instance_id === "portugal"
        ? { ...measurement, value: 0.7 }
        : measurement
    );

    expect(() => resolveTopologyMeasurements(topology, metrics, changed, "wins", "avg")).toThrow(/conflicts with its children/);
  });

  it("allows a parent-only observation and carries it through deeper projections", () => {
    const parentOnlyTopology: TopologyDocument = {
      unknownValues: "strict",
      layers: [{ key: "group" }, { key: "pod" }],
      nodes: [{ key: "kafka", layer: "group", children: ["kafka-0", "kafka-1"] }]
    };
    const parentOnlyMetrics: MetricsDocument = {
      metrics: { cpu: { aggregation: "sum" } }
    };
    const projected = resolveTopologyMeasurements(
      parentOnlyTopology,
      parentOnlyMetrics,
      [row("run-001", "cpu", "avg", "kafka", 30)],
      "cpu",
      "avg",
      "pod"
    ).projected;

    expect(projected).toContainEqual({
      run_id: "run-001",
      metric_id: "cpu",
      stat: "avg",
      instance_id: "kafka",
      value: 30,
      topology_level: "pod",
      topology_level_index: 1,
      source: "observed"
    });
  });

  it("rejects underivable missing observations", () => {
    const withoutAmerica = observations.filter((measurement) => measurement.instance_id !== "america");
    expect(() => resolveTopologyMeasurements(topology, metrics, withoutAmerica, "wins", "avg")).toThrow(/cannot resolve "america"/);
  });

  it("supports strict, permissive, and ignore unknown modes", () => {
    const strictTopology = { ...topology, unknownValues: "strict" as const };
    const ignoreTopology = { ...topology, unknownValues: "ignore" as const };

    expect(() => resolveTopologyMeasurements(strictTopology, metrics, observations, "matches", "avg")).toThrow(/unknown topology node "narnia"/);

    const permissive = resolveTopologyMeasurements(topology, metrics, observations, "matches", "avg", "region");
    expect(permissive.projected.some((item) => item.instance_id === "narnia")).toBe(true);

    const ignored = resolveTopologyMeasurements(ignoreTopology, metrics, observations, "matches", "avg", "region");
    expect(ignored.projected.some((item) => item.instance_id === "narnia")).toBe(false);
    expect(ignored.warnings.some((warning) => warning.message.includes('Ignoring unknown topology node "narnia"'))).toBe(true);
  });

  it("detects ambiguous max derivation", () => {
    const maxMetrics: MetricsDocument = { metrics: { cpu: { aggregation: "sum" }, peak: { aggregation: "max" } } };
    const maxMeasurements = [
      row("run-001", "peak", "max", "america", 20),
      row("run-001", "peak", "max", "rio", 20),
      row("run-001", "peak", "max", "sao_paulo", 10),
      row("run-001", "peak", "max", "caracas", 8)
    ];

    expect(() => resolveTopologyMeasurements(topology, maxMetrics, maxMeasurements, "peak", "max")).toThrow(/cannot derive missing child/);
  });
});
