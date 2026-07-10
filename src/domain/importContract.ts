import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { parseCsvRows, type CsvParseResult, type CsvRowSource } from "./csv";
import { evaluateFeatureAvailability, featureRegistry } from "./featureRegistry";
import {
  configRecordSchema,
  csvColumns,
  manifestDocumentSchema,
  measurementRecordSchema,
  metricsDocumentSchema,
  notesDocumentSchema,
  runRecordSchema,
  scenarioRecordSchema,
  scenarioHelpDocumentSchema,
  saturationDocumentSchema,
  testRecordSchema,
  topologyDocumentSchema
} from "./schemas";
import { buildTopologyGraph, resolveTopologyMeasurements, validateMetricsDocument } from "./topologyMetrics";
import type {
  ConfigRecord,
  ImportedPackage,
  ImportFileSource,
  ImportValidationReport,
  ImportValidationResult,
  ManifestDocument,
  MeasurementRecord,
  MetricsDocument,
  NotesDocument,
  RunRecord,
  ScenarioHelpDocument,
  ScenarioHelpEntry,
  ScenarioRecord,
  SaturationDocument,
  TestRecord,
  TopologyDocument,
  ValidationIssue
} from "./types";

const requiredTextFiles = [
  "manifest.yaml",
  "runs.csv",
  "tests.csv",
  "configs.csv",
  "scenarios.csv",
  "measurements.csv",
  "metrics.yaml",
  "topology.yaml",
  "saturation.yaml",
  "notes.yaml"
];

const optionalScenarioHelpFile = "scenario-help.yaml";

function issue(severity: "error" | "warning", message: string, file?: string, path?: string): ValidationIssue {
  return { severity, message, file, path };
}

function emptyReport(errors: ValidationIssue[], warnings: ValidationIssue[]): ImportValidationReport {
  return {
    valid: errors.length === 0,
    errors,
    warnings,
    features: evaluateFeatureAvailability([], [])
  };
}

function parseYamlDocument<T>(
  file: string,
  text: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  errors: ValidationIssue[]
): T | undefined {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    errors.push(issue("error", error instanceof Error ? error.message : "Invalid YAML.", file));
    return undefined;
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    for (const detail of result.error.issues) {
      errors.push(
        issue(
          "error",
          detail.message,
          file,
          detail.path.length > 0 ? `${file}:${detail.path.join(".")}` : file
        )
      );
    }
    return undefined;
  }

  return result.data;
}

function uniqueValues<T>(items: T[]): Set<T> {
  return new Set(items);
}

function addDuplicateErrors<T>(
  items: T[],
  keyFor: (item: T) => string,
  file: string,
  label: string,
  errors: ValidationIssue[]
) {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const item of items) {
    const key = keyFor(item);
    if (seen.has(key)) duplicates.add(key);
    seen.add(key);
  }

  for (const duplicate of duplicates) {
    errors.push(issue("error", `Duplicate ${label}: ${duplicate}.`, file));
  }
}

function rowWord(count: number): string {
  return count === 1 ? "row" : "rows";
}

function normalizeAssetPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "").replace(/^\.\//, "");
}

function isRelativeAssetPath(path: string): boolean {
  const normalized = normalizeAssetPath(path);
  return normalized.length > 0 && !/^[a-z]+:/i.test(path) && !normalized.startsWith("../") && !normalized.includes("/../");
}

function mimeTypeForPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

function asUint8Array(bytes: Uint8Array | ArrayLike<number>): Uint8Array {
  return bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
}

function bytesToBase64(input: Uint8Array | ArrayLike<number>): string {
  const bytes = asUint8Array(input);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function readOptionalText(source: ImportFileSource, relativePath: string): Promise<string | undefined> {
  try {
    return await source.readText(relativePath);
  } catch {
    return undefined;
  }
}

async function listImportRootFiles(
  source: ImportFileSource,
  warnings: ValidationIssue[]
): Promise<string[] | undefined> {
  if (!source.listFiles) return undefined;

  try {
    return [...new Set((await source.listFiles()).map(normalizeAssetPath).filter((path) => path.length > 0))];
  } catch (error) {
    warnings.push(
      issue(
        "warning",
        error instanceof Error
          ? `Unable to list package files: ${error.message}. Only canonical CSV files will be imported.`
          : "Unable to list package files. Only canonical CSV files will be imported.",
        "import"
      )
    );
    return undefined;
  }
}

function csvFragmentFiles(canonicalFile: string, sourceFiles: string[] | undefined): string[] {
  if (!sourceFiles) return [canonicalFile];

  const suffix = `.${canonicalFile}`;
  const extras = sourceFiles
    .filter((file) => !file.includes("/"))
    .filter((file) => file !== canonicalFile && file.endsWith(suffix))
    .sort((a, b) => a.localeCompare(b));

  return [canonicalFile, ...extras];
}

async function parseCsvFragments<T>(
  source: ImportFileSource,
  texts: Map<string, string>,
  sourceFiles: string[] | undefined,
  canonicalFile: string,
  requiredColumns: string[],
  schema: z.ZodType<T, z.ZodTypeDef, unknown>
): Promise<CsvParseResult<T>> {
  const rows: T[] = [];
  const issues: ValidationIssue[] = [];
  const rowSources = new Map<T, CsvRowSource>();

  for (const file of csvFragmentFiles(canonicalFile, sourceFiles)) {
    let text: string;
    if (file === canonicalFile) {
      text = texts.get(canonicalFile) ?? "";
    } else {
      try {
        text = await source.readText(file);
      } catch (error) {
        issues.push(
          issue(
            "error",
            error instanceof Error ? `Unable to read ${file}: ${error.message}` : `Unable to read ${file}.`,
            file
          )
        );
        continue;
      }
    }

    const result = parseCsvRows<T>(file, text, requiredColumns, schema);
    for (const row of result.rows) {
      rows.push(row);
      const rowSource = result.rowSources.get(row);
      if (rowSource) {
        rowSources.set(row, rowSource);
      }
    }
    issues.push(...result.issues);
  }

  return { rows, issues, rowSources };
}

async function loadScenarioHelpAssets(
  scenarioHelp: ScenarioHelpDocument,
  scenarios: ScenarioRecord[],
  source: ImportFileSource,
  errors: ValidationIssue[]
): Promise<ScenarioHelpDocument> {
  const scenarioIds = new Set(scenarios.map((scenario) => scenario.scenario_id));
  const hydratedScenarios: Record<string, ScenarioHelpEntry> = {};

  for (const [scenarioId, help] of Object.entries(scenarioHelp.scenarios)) {
    if (!scenarioIds.has(scenarioId)) {
      errors.push(issue("error", `scenario-help.yaml references unknown scenario_id "${scenarioId}".`, optionalScenarioHelpFile));
    }

    const images: ScenarioHelpEntry["images"] = [];
    for (const image of help.images) {
      const normalizedPath = normalizeAssetPath(image.path);
      if (!isRelativeAssetPath(image.path)) {
        errors.push(issue("error", `Scenario help image path "${image.path}" must be relative to the package root.`, optionalScenarioHelpFile));
        continue;
      }

      try {
        const bytes = await source.readBytes(normalizedPath);
        const mimeType = mimeTypeForPath(normalizedPath);
        images.push({
          ...image,
          path: normalizedPath,
          mimeType,
          dataUrl: `data:${mimeType};base64,${bytesToBase64(bytes)}`
        });
      } catch (error) {
        const errorText = error instanceof Error ? error.message : String(error);
        errors.push(
          issue(
            "error",
            `Unable to read scenario help image "${normalizedPath}": ${errorText}`,
            optionalScenarioHelpFile
          )
        );
      }
    }

    hydratedScenarios[scenarioId] = { ...help, images };
  }

  return { ...scenarioHelp, scenarios: hydratedScenarios };
}

function addGroupedIssues<T>(
  items: T[],
  keyFor: (item: T) => string | undefined,
  file: string,
  severity: "error" | "warning",
  messageFor: (key: string, count: number) => string,
  target: ValidationIssue[]
) {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = keyFor(item);
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  for (const [key, count] of counts) {
    target.push(issue(severity, messageFor(key, count), file));
  }
}

function plannedPairKey(item: Pick<TestRecord | RunRecord, "scenario_id" | "config_id">): string {
  return `${item.scenario_id} / ${item.config_id}`;
}

function topologyValidationTargets(saturation: SaturationDocument): Array<{ metric_id: string; stat: string }> {
  const targets = new Map<string, { metric_id: string; stat: string }>();
  const addTarget = (metric_id: string, stat: string) => {
    targets.set(`${metric_id}|${stat}`, { metric_id, stat });
  };

  for (const feature of featureRegistry) {
    for (const requirement of feature.requirements) {
      if (requirement.instance_id === undefined) {
        addTarget(requirement.metric_id, requirement.stat);
      }
    }
  }

  for (const rule of saturation.defaults.saturatedWhen) {
    addTarget(rule.metric_id, rule.stat);
  }

  return [...targets.values()];
}

function crossValidate(input: {
  metrics: MetricsDocument;
  topology: TopologyDocument;
  saturation: SaturationDocument;
  notes: NotesDocument;
  scenarios: ScenarioRecord[];
  configs: ConfigRecord[];
  tests: TestRecord[];
  runs: RunRecord[];
  measurements: MeasurementRecord[];
  measurementSources: Map<MeasurementRecord, CsvRowSource>;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}) {
  const {
    metrics,
    topology,
    saturation,
    notes,
    scenarios,
    configs,
    tests,
    runs,
    measurements,
    measurementSources,
    errors,
    warnings
  } = input;
  const runIds = uniqueValues(runs.map((run) => run.run_id));
  const plannedPairKeys = uniqueValues(tests.map(plannedPairKey));
  const configIds = uniqueValues(configs.map((config) => config.config_id));
  const scenarioIds = uniqueValues(scenarios.map((scenario) => scenario.scenario_id));
  const metricIds = uniqueValues(Object.keys(metrics.metrics));

  addDuplicateErrors(scenarios, (scenario) => scenario.scenario_id, "scenarios.csv", "scenario_id", errors);
  addDuplicateErrors(configs, (config) => config.config_id, "configs.csv", "config_id", errors);
  addDuplicateErrors(tests, plannedPairKey, "tests.csv", "planned scenario/config pair", errors);
  addDuplicateErrors(runs, (run) => run.run_id, "runs.csv", "run_id", errors);
  addDuplicateErrors(
    measurements,
    (measurement) =>
      [
        measurement.run_id,
        measurement.metric_id,
        measurement.stat,
        measurement.instance_id
      ].join("|"),
    "measurements.csv",
    "measurement fact",
    errors
  );

  addGroupedIssues(
    configs,
    (config) => (/(^|,)exagon:/i.test(config.components_ver) ? config.config_id : undefined),
    "configs.csv",
    "warning",
    (configId) => `components_ver for config_id "${configId}" includes exagon; keep exagon in exagon_ver instead.`,
    warnings
  );

  addGroupedIssues(
    tests,
    (test) => (!scenarioIds.has(test.scenario_id) ? test.scenario_id : undefined),
    "tests.csv",
    "error",
    (scenarioId, count) => `Test references unknown scenario_id "${scenarioId}" in ${count} ${rowWord(count)}.`,
    errors
  );

  addGroupedIssues(
    tests,
    (test) => (!configIds.has(test.config_id) ? test.config_id : undefined),
    "tests.csv",
    "error",
    (configId, count) => `Test references unknown config_id "${configId}" in ${count} ${rowWord(count)}.`,
    errors
  );

  addGroupedIssues(
    runs,
    (run) => (!scenarioIds.has(run.scenario_id) ? run.scenario_id : undefined),
    "runs.csv",
    "error",
    (scenarioId, count) => `Run references unknown scenario_id "${scenarioId}" in ${count} ${rowWord(count)}.`,
    errors
  );

  addGroupedIssues(
    runs,
    (run) => (!configIds.has(run.config_id) ? run.config_id : undefined),
    "runs.csv",
    "error",
    (configId, count) => `Run references unknown config_id "${configId}" in ${count} ${rowWord(count)}.`,
    errors
  );

  addGroupedIssues(
    runs,
    (run) => (!plannedPairKeys.has(plannedPairKey(run)) ? plannedPairKey(run) : undefined),
    "runs.csv",
    "warning",
    (key, count) => `Run has no planned test entry for scenario/config "${key}" in ${count} ${rowWord(count)}.`,
    warnings
  );

  addGroupedIssues(
    measurements,
    (measurement) => (!runIds.has(measurement.run_id) ? measurement.run_id : undefined),
    "measurements.csv",
    "error",
    (runId, count) => `Measurement references unknown run_id "${runId}" in ${count} ${rowWord(count)}.`,
    errors
  );

  addGroupedIssues(
    measurements,
    (measurement) => (!metricIds.has(measurement.metric_id) ? measurement.metric_id : undefined),
    "measurements.csv",
    "error",
    (metricId, count) => `metric_id "${metricId}" is not defined in metrics.yaml in ${count} ${rowWord(count)}.`,
    errors
  );

  for (const message of validateMetricsDocument(metrics)) {
    errors.push(issue("error", message, "metrics.yaml"));
  }

  try {
    buildTopologyGraph(topology);
  } catch (error) {
    errors.push(issue("error", error instanceof Error ? error.message : String(error), "topology.yaml"));
  }

  if (errors.length === 0) {
    for (const target of topologyValidationTargets(saturation)) {
      if (!metricIds.has(target.metric_id)) continue;
      if (!metrics.metrics[target.metric_id]?.topology) continue;

      try {
        const resolution = resolveTopologyMeasurements(
          topology,
          metrics,
          measurements,
          target.metric_id,
          target.stat,
          undefined,
          {
            sourceForMeasurement: (measurement) => measurementSources.get(measurement)
          }
        );
        warnings.push(...resolution.warnings);
      } catch (error) {
        const topologyError = error as { file?: string; path?: string };
        errors.push(
          issue(
            "error",
            error instanceof Error ? error.message : String(error),
            topologyError.file ?? "measurements.csv",
            topologyError.path
          )
        );
      }
    }
  }

  addGroupedIssues(
    saturation.defaults.saturatedWhen,
    (rule) => (!metricIds.has(rule.metric_id) ? rule.metric_id : undefined),
    "saturation.yaml",
    "error",
    (metricId, count) => `Saturation rule references unknown metric_id "${metricId}" in ${count} ${rowWord(count)}.`,
    errors
  );

  addGroupedIssues(
    saturation.overrides,
    (override) => (!runIds.has(override.run_id) ? override.run_id : undefined),
    "saturation.yaml",
    "error",
    (runId, count) => `Saturation override references unknown run_id "${runId}" in ${count} ${rowWord(count)}.`,
    errors
  );

  addGroupedIssues(
    notes.runs,
    (note) => (!runIds.has(note.run_id) ? note.run_id : undefined),
    "notes.yaml",
    "warning",
    (runId, count) => `Run note references unknown run_id "${runId}" in ${count} ${rowWord(count)}.`,
    warnings
  );

  addGroupedIssues(
    notes.comparisons.flatMap((note) => [note.baseline_run_id, note.candidate_run_id]),
    (runId) => (!runIds.has(runId) ? runId : undefined),
    "notes.yaml",
    "warning",
    (runId, count) => `Comparison note references unknown run_id "${runId}" in ${count} ${rowWord(count)}.`,
    warnings
  );

  try {
    if (buildTopologyGraph(topology).nodes.size === 0) {
      warnings.push(issue("warning", "No topology nodes were defined. Topology projections will be unavailable.", "topology.yaml"));
    }
  } catch {
    // The topology parse error is already reported above.
  }
}

function makePackageId(rootName: string): string {
  const suffix =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${rootName.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${suffix}`;
}

export async function validateImportSource(source: ImportFileSource): Promise<ImportValidationResult> {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const texts = new Map<string, string>();

  for (const file of requiredTextFiles) {
    try {
      texts.set(file, await source.readText(file));
    } catch (error) {
      errors.push(
        issue(
          "error",
          error instanceof Error ? `Unable to read ${file}: ${error.message}` : `Unable to read ${file}.`,
          file
        )
      );
    }
  }

  if (source.hasDirectory) {
    const hasRaw = await source.hasDirectory("raw");
    if (hasRaw === false) {
      errors.push(issue("error", "Required raw/ directory is missing.", "raw/"));
    }
  } else {
    warnings.push(issue("warning", "raw/ directory presence could not be verified in this browser import mode.", "raw/"));
  }

  if (errors.length > 0) {
    return { report: emptyReport(errors, warnings) };
  }

  const manifest = parseYamlDocument<ManifestDocument>(
    "manifest.yaml",
    texts.get("manifest.yaml") ?? "",
    manifestDocumentSchema,
    errors
  );
  const topology = parseYamlDocument<TopologyDocument>(
    "topology.yaml",
    texts.get("topology.yaml") ?? "",
    topologyDocumentSchema,
    errors
  );
  const saturation = parseYamlDocument<SaturationDocument>(
    "saturation.yaml",
    texts.get("saturation.yaml") ?? "",
    saturationDocumentSchema,
    errors
  );
  const notes = parseYamlDocument<NotesDocument>("notes.yaml", texts.get("notes.yaml") ?? "", notesDocumentSchema, errors);
  const metrics = parseYamlDocument<MetricsDocument>(
    "metrics.yaml",
    texts.get("metrics.yaml") ?? "",
    metricsDocumentSchema,
    errors
  );
  const scenarioHelpText = await readOptionalText(source, optionalScenarioHelpFile);
  const parsedScenarioHelp = scenarioHelpText !== undefined
    ? parseYamlDocument<ScenarioHelpDocument>(
        optionalScenarioHelpFile,
        scenarioHelpText,
        scenarioHelpDocumentSchema,
        errors
      )
    : undefined;
  const sourceFiles = await listImportRootFiles(source, warnings);

  const runsResult = await parseCsvFragments<RunRecord>(
    source,
    texts,
    sourceFiles,
    "runs.csv",
    csvColumns.runs,
    runRecordSchema
  );
  const testsResult = await parseCsvFragments<TestRecord>(
    source,
    texts,
    sourceFiles,
    "tests.csv",
    csvColumns.tests,
    testRecordSchema
  );
  const configsResult = await parseCsvFragments<ConfigRecord>(
    source,
    texts,
    sourceFiles,
    "configs.csv",
    csvColumns.configs,
    configRecordSchema
  );
  const scenariosResult = await parseCsvFragments<ScenarioRecord>(
    source,
    texts,
    sourceFiles,
    "scenarios.csv",
    csvColumns.scenarios,
    scenarioRecordSchema
  );
  const measurementsResult = await parseCsvFragments<MeasurementRecord>(
    source,
    texts,
    sourceFiles,
    "measurements.csv",
    csvColumns.measurements,
    measurementRecordSchema
  );
  errors.push(
    ...runsResult.issues.filter((item) => item.severity === "error"),
    ...testsResult.issues.filter((item) => item.severity === "error"),
    ...configsResult.issues.filter((item) => item.severity === "error"),
    ...scenariosResult.issues.filter((item) => item.severity === "error"),
    ...measurementsResult.issues.filter((item) => item.severity === "error")
  );
  warnings.push(
    ...runsResult.issues.filter((item) => item.severity === "warning"),
    ...testsResult.issues.filter((item) => item.severity === "warning"),
    ...configsResult.issues.filter((item) => item.severity === "warning"),
    ...scenariosResult.issues.filter((item) => item.severity === "warning"),
    ...measurementsResult.issues.filter((item) => item.severity === "warning")
  );
  if (manifest && metrics && topology && saturation && notes) {
    crossValidate({
      metrics,
      topology,
      saturation,
      notes,
      scenarios: scenariosResult.rows,
      configs: configsResult.rows,
      tests: testsResult.rows,
      runs: runsResult.rows,
      measurements: measurementsResult.rows,
      measurementSources: measurementsResult.rowSources,
      errors,
      warnings
    });
  }

  const scenarioHelp = parsedScenarioHelp
    ? await loadScenarioHelpAssets(parsedScenarioHelp, scenariosResult.rows, source, errors)
    : undefined;

  const features = evaluateFeatureAvailability(runsResult.rows, measurementsResult.rows);
  const report: ImportValidationReport = {
    valid: errors.length === 0,
    errors,
    warnings,
    features
  };

  if (!report.valid || !manifest || !metrics || !topology || !saturation || !notes) {
    return { report };
  }

  const pkg: ImportedPackage = {
    id: makePackageId(source.rootName),
    name: source.rootName,
    importedAt: new Date().toISOString(),
    sourcePath: source.sourcePath,
    manifest,
    metrics,
    topology,
    saturation,
    notes,
    scenarioHelp,
    scenarios: scenariosResult.rows,
    configs: configsResult.rows,
    tests: testsResult.rows,
    runs: runsResult.rows,
    measurements: measurementsResult.rows,
    validationReport: report
  };

  return { package: pkg, report };
}
