import { readFile, stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { validateImportSource } from "./importContract";
import { buildCpuRegressionAnalyses, buildCpuRegressionRows } from "./regression";
import type { ImportFileSource } from "./types";

function fixtureSource(rootName: string): ImportFileSource {
  return {
    rootName,
    readText: async (relativePath) =>
      readFile(new URL(`../../fixtures/${rootName}/${relativePath}`, import.meta.url), "utf8"),
    readBytes: async (relativePath) =>
      new Uint8Array(await readFile(new URL(`../../fixtures/${rootName}/${relativePath}`, import.meta.url))),
    hasDirectory: async (relativePath) => {
      try {
        return (await stat(new URL(`../../fixtures/${rootName}/${relativePath}`, import.meta.url))).isDirectory();
      } catch {
        return false;
      }
    }
  };
}

describe("CPU regression", () => {
  it("builds one hyperbolic regression row per executed run identity", async () => {
    const result = await validateImportSource(fixtureSource("real-perf-import"));
    const rows = buildCpuRegressionRows(result.package!);
    const runTestKeys = new Set(
      result.package!.runs.map((run) => `${run.scenario_id} / ${run.config_id} / #${run.sequence_id}`)
    );

    expect(rows).toHaveLength(runTestKeys.size);
    expect(new Set(rows.map((row) => row.testKey))).toEqual(runTestKeys);
    expect(rows.every((row) => row.sequenceId === 0)).toBe(true);
  });

  it("does not create regression rows for planned tests without runs", async () => {
    const result = await validateImportSource(fixtureSource("perf-import"));
    const pkg = {
      ...result.package!,
      tests: [
        ...result.package!.tests,
        { scenario_id: "checkout", config_id: "cfg-planned-only" }
      ],
      configs: [
        ...result.package!.configs,
        { config_id: "cfg-planned-only", exagon_ver: "planned-only", components_ver: "" }
      ]
    };

    const rows = buildCpuRegressionRows(pkg);

    expect(rows.some((row) => row.configId === "cfg-planned-only")).toBe(false);
    expect(rows.map((row) => row.testKey).sort()).toEqual(
      [...new Set(pkg.runs.map((run) => `${run.scenario_id} / ${run.config_id} / #${run.sequence_id}`))].sort()
    );
  });

  it("matches the known parallel command hyperbolic CPU fit", async () => {
    const result = await validateImportSource(fixtureSource("real-perf-import"));
    const rows = buildCpuRegressionRows(result.package!);
    const parallelCommand = rows.find((row) => row.scenarioId === "parallel_command");

    expect(parallelCommand).toBeDefined();
    expect(parallelCommand?.configId).toBe("cfg-e8c9c6d6");
    expect(parallelCommand?.fittedPoints).toBe(11);
    expect(parallelCommand?.totalPoints).toBe(11);
    expect(parallelCommand?.idle).toBeCloseTo(970.35, 1);
    expect(parallelCommand?.marginalCpu).toBeCloseTo(2.7979, 3);
    expect(parallelCommand?.transientOverhead).toBeCloseTo(4863.08, 0);
    expect(parallelCommand?.halfSaturationK).toBeCloseTo(240.7, 0);
    expect(parallelCommand?.rSquared).toBeCloseTo(0.9987, 3);
  });

  it("keeps saturated points in the total while excluding them from the fit", async () => {
    const result = await validateImportSource(fixtureSource("real-perf-import"));
    const rows = buildCpuRegressionRows(result.package!);
    const cacheNone = rows.find((row) => row.scenarioId === "rwro_none");

    expect(cacheNone).toBeDefined();
    expect(cacheNone?.fittedPoints).toBe(8);
    expect(cacheNone?.totalPoints).toBe(11);
  });

  it("exposes chart points with fit membership and comparison metrics", async () => {
    const result = await validateImportSource(fixtureSource("real-perf-import"));
    const rows = buildCpuRegressionAnalyses(result.package!);
    const cacheNone = rows.find((row) => row.scenarioId === "rwro_none");

    expect(cacheNone).toBeDefined();
    expect(cacheNone?.points).toHaveLength(cacheNone?.totalPoints ?? 0);
    expect(cacheNone?.points.filter((point) => point.fitted)).toHaveLength(cacheNone?.fittedPoints ?? 0);
    expect(cacheNone?.points.some((point) => point.saturated)).toBe(true);
    expect(cacheNone?.points.every((point) => point.latencyAvg !== undefined)).toBe(true);
    expect(cacheNone?.points.some((point) => point.maxThrottling !== undefined)).toBe(true);
  });
});
