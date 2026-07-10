import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { validateImportSource } from "../domain/importContract";
import { sourceFromZipBytes, sourceFromZipBytesAtPath } from "./importSources";

const fixtureFiles = [
  "manifest.yaml",
  "runs.csv",
  "tests.csv",
  "configs.csv",
  "scenarios.csv",
  "measurements.csv",
  "metrics.yaml",
  "topology.yaml",
  "saturation.yaml",
  "notes.yaml",
  "raw/README.md"
];

async function fixtureZipBytes(rootPrefix = "", extraFiles: Record<string, string | Uint8Array> = {}): Promise<Uint8Array> {
  const zip = new JSZip();

  await Promise.all(
    fixtureFiles.map(async (relativePath) => {
      const text = await readFile(new URL(`../../fixtures/perf-import/${relativePath}`, import.meta.url), "utf8");
      zip.file(`${rootPrefix}${relativePath}`, text);
    })
  );
  for (const [relativePath, content] of Object.entries(extraFiles)) {
    zip.file(`${rootPrefix}${relativePath}`, content);
  }

  return zip.generateAsync({ type: "uint8array" });
}

describe("import zip sources", () => {
  it("accepts a zip with contract files at the archive root", async () => {
    const source = await sourceFromZipBytes("perf-import.zip", await fixtureZipBytes(), "perf-import.zip");
    const result = await validateImportSource(source);

    expect(result.report.valid).toBe(true);
    expect(result.package?.name).toBe("perf-import");
    expect(result.package?.runs).toHaveLength(4);
  });

  it("accepts a zip with the contract files inside one wrapping folder", async () => {
    const source = await sourceFromZipBytes("download.zip", await fixtureZipBytes("perf-import/"), "download.zip");
    const result = await validateImportSource(source);

    expect(result.report.valid).toBe(true);
    expect(result.package?.name).toBe("perf-import");
    await expect(source.hasDirectory?.("raw")).resolves.toBe(true);
  });

  it("accepts a zip with the contract files at a configured nested package path", async () => {
    const source = await sourceFromZipBytesAtPath(
      "repo-main.zip",
      await fixtureZipBytes("repo-main/reports/latest/perf-import/"),
      "reports/latest/perf-import",
      "repo-main.zip"
    );
    const result = await validateImportSource(source);

    expect(result.report.valid).toBe(true);
    expect(result.package?.name).toBe("perf-import");
    await expect(source.hasDirectory?.("raw")).resolves.toBe(true);
  });

  it("accepts split CSV fragments from a configured nested zip package path", async () => {
    const source = await sourceFromZipBytesAtPath(
      "repo-main.zip",
      await fixtureZipBytes("repo-main/reports/latest/perf-import/", {
        "extra.configs.csv": `config_id,exagon_ver,components_ver
cfg-extra,3.14.0,"kafka:3.8.0"
`,
        "extra.tests.csv": `scenario_id,config_id
checkout,cfg-extra
`,
        "part2.runs.csv": `run_id,scenario_id,config_id,sequence_id,target_tps,started_at,duration
run-005,checkout,cfg-extra,0,750,2026-06-22T09:00:00Z,30m
`
      }),
      "reports/latest/perf-import",
      "repo-main.zip"
    );
    const result = await validateImportSource(source);

    expect(result.report.valid).toBe(true);
    expect(result.package?.runs.map((run) => run.run_id)).toContain("run-005");
    expect(result.package?.runs).toHaveLength(5);
  });

  it("reads binary assets from a zip at the package root", async () => {
    const zip = new JSZip();
    const imageBytes = new Uint8Array([1, 2, 3, 4]);

    await Promise.all(
      fixtureFiles.map(async (relativePath) => {
        const text = await readFile(new URL(`../../fixtures/perf-import/${relativePath}`, import.meta.url), "utf8");
        zip.file(`repo-main/reports/latest/perf-import/${relativePath}`, text);
      })
    );
    zip.file("repo-main/reports/latest/perf-import/help/images/example.png", imageBytes);

    const source = await sourceFromZipBytesAtPath(
      "repo-main.zip",
      await zip.generateAsync({ type: "uint8array" }),
      "reports/latest/perf-import",
      "repo-main.zip"
    );

    await expect(source.readBytes("help/images/example.png")).resolves.toEqual(imageBytes);
  });
});
