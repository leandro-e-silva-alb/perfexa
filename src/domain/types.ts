export type MetricId = string;
export type StatId = string;
export type InstanceType = "run" | "pod" | string;
export type AggregationMethod = "sum" | "avg" | "min" | "max";
export type AvailabilityStatus = "available" | "partial" | "unavailable";
export type SaturationOperator = ">" | ">=" | "<" | "<=" | "=" | "==" | "!=";

export interface RunRecord {
  run_id: string;
  scenario_id: string;
  config_id: string;
  sequence_id: number;
  target_tps: number;
  started_at: string;
  duration: string;
}

export interface ScenarioRecord {
  scenario_id: string;
  name: string;
}

export interface TestRecord {
  scenario_id: string;
  config_id: string;
  sequence_id: number;
}

export interface ConfigRecord {
  config_id: string;
  exagon_ver: string;
  components_ver: string;
}

export interface MeasurementRecord {
  run_id: string;
  metric_id: MetricId;
  stat: StatId;
  instance_type: InstanceType;
  instance_id: string;
  value: number;
}

export interface MetricDefinition {
  unit: string;
  description: string;
}

export interface MetricsDocument {
  schemaVersion: 1;
  metrics: Record<MetricId, MetricDefinition>;
}

export interface ComponentDefinition {
  label: string;
  kind: "application" | "service" | "infrastructure" | string;
}

export interface ManifestDocument {
  schemaVersion: 1;
  components: Record<string, ComponentDefinition>;
}

export interface TopologyGroup {
  members: string[];
  aggregations: Record<MetricId, AggregationMethod>;
}

export interface TopologyDocument {
  schemaVersion: 1;
  groups: Record<string, TopologyGroup>;
}

export interface SaturationRule {
  metric_id: MetricId;
  stat: StatId;
  instance_type: InstanceType;
  instance_id?: string;
  operator: SaturationOperator;
  value: number;
}

export interface SaturationOverride {
  run_id: string;
  saturated: boolean;
  reason: string;
}

export interface SaturationDocument {
  schemaVersion: 1;
  defaults: {
    saturatedWhen: SaturationRule[];
  };
  overrides: SaturationOverride[];
}

export interface RunNote {
  run_id: string;
  body: string;
  author?: string;
  updated_at?: string;
}

export interface ComparisonNote {
  baseline_run_id: string;
  candidate_run_id: string;
  conclusion: string;
  author?: string;
  updated_at?: string;
}

export interface NotesDocument {
  schemaVersion: 1;
  runs: RunNote[];
  comparisons: ComparisonNote[];
}

export interface FeatureRequirement {
  metric_id: MetricId;
  stat: StatId;
  instance_type: InstanceType;
  label: string;
}

export interface AppFeature {
  id: string;
  label: string;
  description: string;
  requirements: FeatureRequirement[];
}

export interface FeatureAvailability {
  featureId: string;
  label: string;
  description: string;
  status: AvailabilityStatus;
  presentCount: number;
  requiredCount: number;
  missing: string[];
}

export interface ValidationIssue {
  severity: "error" | "warning";
  file?: string;
  path?: string;
  message: string;
}

export interface ImportValidationReport {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  features: FeatureAvailability[];
}

export interface ImportedPackage {
  id: string;
  name: string;
  importedAt: string;
  sourcePath?: string;
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
  validationReport: ImportValidationReport;
}

export interface ImportFileSource {
  rootName: string;
  sourcePath?: string;
  readText(relativePath: string): Promise<string>;
  hasDirectory?(relativePath: string): Promise<boolean | undefined>;
}

export interface ImportValidationResult {
  package?: ImportedPackage;
  report: ImportValidationReport;
}

export interface SaturationEvaluation {
  run_id: string;
  saturated: boolean;
  source: "override" | "rule" | "none";
  reason: string;
  matchedRules: string[];
}
