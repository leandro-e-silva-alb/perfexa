import { z } from "zod";
import type {
  ConfigRecord,
  ManifestDocument,
  MeasurementRecord,
  MetricsDocument,
  NotesDocument,
  RunRecord,
  ScenarioRecord,
  SaturationDocument,
  TestRecord,
  TopologyDocument
} from "./types";

const textCell: z.ZodType<string, z.ZodTypeDef, unknown> = z.preprocess(
  (value) => (typeof value === "string" ? value.trim() : value),
  z.string()
);

const requiredText: z.ZodType<string, z.ZodTypeDef, unknown> = textCell.pipe(
  z.string().min(1, "Required")
);

const numberCell: z.ZodType<number, z.ZodTypeDef, unknown> = z.preprocess((value) => {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return Number(trimmed);
}, z.number().finite("Must be a finite number"));

const sequenceIdCell: z.ZodType<number, z.ZodTypeDef, unknown> = numberCell.pipe(
  z.number().int("Must be an integer").min(0, "Must be 0 or greater")
);

export const runRecordSchema: z.ZodType<RunRecord, z.ZodTypeDef, unknown> = z.object({
  run_id: requiredText,
  scenario_id: requiredText,
  config_id: requiredText,
  sequence_id: sequenceIdCell,
  target_tps: numberCell,
  started_at: requiredText,
  duration: requiredText
});

export const scenarioRecordSchema: z.ZodType<ScenarioRecord, z.ZodTypeDef, unknown> = z.object({
  scenario_id: requiredText,
  name: requiredText
});

export const testRecordSchema: z.ZodType<TestRecord, z.ZodTypeDef, unknown> = z.object({
  scenario_id: requiredText,
  config_id: requiredText,
  sequence_id: sequenceIdCell
});

export const configRecordSchema: z.ZodType<ConfigRecord, z.ZodTypeDef, unknown> = z.object({
  config_id: requiredText,
  exagon_ver: requiredText,
  components_ver: requiredText
});

export const measurementRecordSchema: z.ZodType<MeasurementRecord, z.ZodTypeDef, unknown> = z.object({
  run_id: requiredText,
  metric_id: requiredText,
  stat: requiredText,
  instance_type: requiredText,
  instance_id: textCell.default(""),
  value: numberCell
});

export const metricsDocumentSchema: z.ZodType<MetricsDocument, z.ZodTypeDef, unknown> = z.object({
  schemaVersion: z.literal(1),
  metrics: z.record(
    z.object({
      unit: requiredText,
      description: textCell.default("")
    })
  )
});

export const manifestDocumentSchema: z.ZodType<ManifestDocument, z.ZodTypeDef, unknown> = z.object({
  schemaVersion: z.literal(1),
  components: z
    .record(
      z.object({
        label: requiredText,
        kind: requiredText
      })
    )
    .default({})
});

export const topologyDocumentSchema: z.ZodType<TopologyDocument, z.ZodTypeDef, unknown> = z.object({
  schemaVersion: z.literal(1),
  groups: z
    .record(
      z.object({
        members: z.array(requiredText).min(1, "A group must have at least one member"),
        aggregations: z.record(z.enum(["sum", "avg", "min", "max"]))
      })
    )
    .default({})
});

export const saturationDocumentSchema: z.ZodType<SaturationDocument, z.ZodTypeDef, unknown> = z.object({
  schemaVersion: z.literal(1),
  defaults: z
    .object({
      saturatedWhen: z
        .array(
          z.object({
            metric_id: requiredText,
            stat: requiredText,
            instance_type: requiredText,
            instance_id: requiredText.optional(),
            operator: z.enum([">", ">=", "<", "<=", "=", "==", "!="]),
            value: numberCell
          })
        )
        .default([])
    })
    .default({ saturatedWhen: [] }),
  overrides: z
    .array(
      z.object({
        run_id: requiredText,
        saturated: z.boolean(),
        reason: textCell.default("")
      })
    )
    .default([])
});

export const notesDocumentSchema: z.ZodType<NotesDocument, z.ZodTypeDef, unknown> = z.object({
  schemaVersion: z.literal(1),
  runs: z
    .array(
      z.object({
        run_id: requiredText,
        body: requiredText,
        author: textCell.optional(),
        updated_at: textCell.optional()
      })
    )
    .default([]),
  comparisons: z
    .array(
      z.object({
        baseline_run_id: requiredText,
        candidate_run_id: requiredText,
        conclusion: requiredText,
        author: textCell.optional(),
        updated_at: textCell.optional()
      })
    )
    .default([])
});

export const csvColumns = {
  runs: ["run_id", "scenario_id", "config_id", "sequence_id", "target_tps", "started_at", "duration"],
  tests: ["scenario_id", "config_id", "sequence_id"],
  configs: ["config_id", "exagon_ver", "components_ver"],
  scenarios: ["scenario_id", "name"],
  measurements: ["run_id", "metric_id", "stat", "instance_type", "instance_id", "value"]
};
