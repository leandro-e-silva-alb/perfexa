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

async function fixtureZipBytes(rootPrefix = ""): Promise<Uint8Array> {
  const zip = new JSZip();

  await Promise.all(
    fixtureFiles.map(async (relativePath) => {
      const text = await readFile(new URL(`../../fixtures/perf-import/${relativePath}`, import.meta.url), "utf8");
      zip.file(`${rootPrefix}${relativePath}`, text);
    })
  );

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
});
