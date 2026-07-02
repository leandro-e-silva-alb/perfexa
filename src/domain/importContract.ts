import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { parseCsvRows } from "./csv";
import { evaluateFeatureAvailability } from "./featureRegistry";
import {
  configRecordSchema,
  csvColumns,
  manifestDocumentSchema,
  measurementRecordSchema,
  metricsDocumentSchema,
  notesDocumentSchema,
  runRecordSchema,
  scenarioRecordSchema,
  saturationDocumentSchema,
  testRecordSchema,
  topologyDocumentSchema
} from "./schemas";
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

function testKey(item: Pick<TestRecord, "scenario_id" | "config_id" | "sequence_id">): string {
  return `${item.scenario_id} / ${item.config_id} / #${item.sequence_id}`;
}

function validateSequenceIds(tests: TestRecord[], errors: ValidationIssue[]): void {
  const byScenarioConfig = new Map<string, TestRecord[]>();
  for (const test of tests) {
    const key = `${test.scenario_id}|${test.config_id}`;
    byScenarioConfig.set(key, [...(byScenarioConfig.get(key) ?? []), test]);
  }

  for (const group of byScenarioConfig.values()) {
    const sequenceIds = [...new Set(group.map((test) => test.sequence_id))].sort((a, b) => a - b);
    const expected = sequenceIds.map((_, index) => index);
    const isContiguousFromZero =
      sequenceIds.length === expected.length && sequenceIds.every((value, index) => value === expected[index]);

    if (!isContiguousFromZero) {
      const first = group[0];
      errors.push(
        issue(
          "error",
          `sequence_id values for scenario_id "${first.scenario_id}" and config_id "${first.config_id}" must start at 0 and have no gaps.`,
          "tests.csv"
        )
      );
    }
  }
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
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}) {
  const { metrics, topology, saturation, notes, scenarios, configs, tests, runs, measurements, errors, warnings } = input;
  const runIds = uniqueValues(runs.map((run) => run.run_id));
  const testKeys = uniqueValues(tests.map(testKey));
  const configIds = uniqueValues(configs.map((config) => config.config_id));
  const scenarioIds = uniqueValues(scenarios.map((scenario) => scenario.scenario_id));
  const metricIds = uniqueValues(Object.keys(metrics.metrics));

  addDuplicateErrors(scenarios, (scenario) => scenario.scenario_id, "scenarios.csv", "scenario_id", errors);
  addDuplicateErrors(configs, (config) => config.config_id, "configs.csv", "config_id", errors);
  addDuplicateErrors(tests, testKey, "tests.csv", "test key", errors);
  addDuplicateErrors(runs, (run) => run.run_id, "runs.csv", "run_id", errors);
  addDuplicateErrors(
    measurements,
    (measurement) =>
      [
        measurement.run_id,
        measurement.metric_id,
        measurement.stat,
        measurement.instance_type,
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
    (run) => (!testKeys.has(testKey(run)) ? testKey(run) : undefined),
    "runs.csv",
    "error",
    (key, count) => `Run references unknown test "${key}" in ${count} ${rowWord(count)}.`,
    errors
  );

  validateSequenceIds(tests, errors);

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

  const groupMeasurementCount = measurements.filter((measurement) => measurement.instance_type === "group").length;
  if (groupMeasurementCount > 0) {
    errors.push(
      issue(
        "error",
        `measurements.csv contains ${groupMeasurementCount} stored group measurement ${rowWord(
          groupMeasurementCount
        )}. Groups are derived from topology.yaml and must not be stored.`,
        "measurements.csv"
      )
    );
  }

  addGroupedIssues(
    measurements,
    (measurement) => (!["run", "pod", "group"].includes(measurement.instance_type) ? measurement.instance_type : undefined),
    "measurements.csv",
    "warning",
    (instanceType, count) =>
      `Unknown instance_type "${instanceType}" appears in ${count} ${rowWord(
        count
      )}; rows will be imported but may not power core screens.`,
    warnings
  );

  for (const [groupId, group] of Object.entries(topology.groups)) {
    if (group.members.length === 0) {
      errors.push(issue("error", `Group "${groupId}" has no members.`, "topology.yaml"));
    }

    for (const metricId of Object.keys(group.aggregations)) {
      if (!metricIds.has(metricId)) {
        warnings.push(
          issue(
            "warning",
            `Group "${groupId}" defines aggregation for metric "${metricId}", but that metric is absent from metrics.yaml.`,
            "topology.yaml"
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

  if (Object.keys(topology.groups).length === 0) {
    warnings.push(issue("warning", "No topology groups were defined. Group views will be unavailable.", "topology.yaml"));
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
  const metrics = parseYamlDocument<MetricsDocument>("metrics.yaml", texts.get("metrics.yaml") ?? "", metricsDocumentSchema, errors);
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

  const runsResult = parseCsvRows<RunRecord>("runs.csv", texts.get("runs.csv") ?? "", csvColumns.runs, runRecordSchema);
  const testsResult = parseCsvRows<TestRecord>(
    "tests.csv",
    texts.get("tests.csv") ?? "",
    csvColumns.tests,
    testRecordSchema
  );
  const configsResult = parseCsvRows<ConfigRecord>(
    "configs.csv",
    texts.get("configs.csv") ?? "",
    csvColumns.configs,
    configRecordSchema
  );
  const scenariosResult = parseCsvRows<ScenarioRecord>(
    "scenarios.csv",
    texts.get("scenarios.csv") ?? "",
    csvColumns.scenarios,
    scenarioRecordSchema
  );
  const measurementsResult = parseCsvRows<MeasurementRecord>(
    "measurements.csv",
    texts.get("measurements.csv") ?? "",
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
      manifest,
      metrics,
      topology,
      saturation,
      notes,
      scenarios: scenariosResult.rows,
      configs: configsResult.rows,
      tests: testsResult.rows,
      runs: runsResult.rows,
      measurements: measurementsResult.rows,
      errors,
      warnings
    } as {
      manifest: ManifestDocument;
      metrics: MetricsDocument;
      topology: TopologyDocument;
      saturation: SaturationDocument;
      notes: NotesDocument;
      scenarios: ScenarioRecord[];
      configs: ConfigRecord[];
      tests: TestRecord[];
      runs: RunRecord[];
      measurements: MeasurementRecord[];
      errors: ValidationIssue[];
      warnings: ValidationIssue[];
    });
  }

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
    scenarios: scenariosResult.rows,
    configs: configsResult.rows,
    tests: testsResult.rows,
    runs: runsResult.rows,
    measurements: measurementsResult.rows,
    validationReport: report
  };

  return { package: pkg, report };
}
