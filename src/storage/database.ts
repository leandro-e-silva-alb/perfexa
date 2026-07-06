import type {
  ImportedPackage,
  MetricAggregation,
  MetricsDocument,
  NotesDocument,
  ScenarioHelpDocument,
  SaturationDocument,
  TopologyDocument
} from "../domain/types";

interface SqlDatabase {
  execute(query: string, bindValues?: unknown[]): Promise<unknown>;
  select<T>(query: string, bindValues?: unknown[]): Promise<T[]>;
}

export interface PerfexaStorage {
  init(): Promise<void>;
  listPackages(): Promise<ImportedPackage[]>;
  getPackage(id: string): Promise<ImportedPackage | undefined>;
  savePackage(pkg: ImportedPackage): Promise<void>;
  updatePackageNotes(id: string, notes: NotesDocument): Promise<void>;
}

const LOCAL_STORAGE_KEY = "perfexa.importedPackages.v1";

const METRIC_AGGREGATIONS: MetricAggregation[] = ["sum", "average", "ratio", "percentage", "max"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isMetricAggregation(value: unknown): value is MetricAggregation {
  return METRIC_AGGREGATIONS.includes(value as MetricAggregation);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function hasCurrentMetrics(value: unknown): value is MetricsDocument {
  if (!isRecord(value) || !isRecord(value.metrics)) return false;
  return Object.values(value.metrics).every(
    (definition) => isRecord(definition) && isMetricAggregation(definition.aggregation)
  );
}

function hasCurrentTopology(value: unknown): value is TopologyDocument {
  if (!isRecord(value) || "groups" in value || "levels" in value || "topology" in value || "standalone" in value) {
    return false;
  }
  if (!Array.isArray(value.layers) || value.layers.length === 0 || !Array.isArray(value.nodes)) return false;

  return (
    value.layers.every(
      (layer) =>
        isRecord(layer) &&
        isString(layer.key) &&
        (layer.symbol === undefined || isString(layer.symbol))
    ) &&
    value.nodes.every(
      (node) =>
        isRecord(node) &&
        isString(node.key) &&
        isString(node.layer) &&
        (node.color === undefined || node.color === null || isString(node.color)) &&
        isStringArray(node.children)
    )
  );
}

function hasCurrentMeasurements(value: unknown): boolean {
  return Array.isArray(value) && value.every((measurement) => {
    if (!isRecord(measurement) || "instance_type" in measurement) return false;
    return (
      isString(measurement.run_id) &&
      isString(measurement.metric_id) &&
      isString(measurement.stat) &&
      isString(measurement.instance_id) &&
      isFiniteNumber(measurement.value)
    );
  });
}

function hasCurrentScenarioHelp(value: unknown): value is ScenarioHelpDocument {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.scenarios)) return false;

  return Object.values(value.scenarios).every((help) => {
    if (!isRecord(help)) return false;
    return (
      isString(help.title) &&
      isString(help.body) &&
      isStringArray(help.microservices) &&
      isStringArray(help.sagas) &&
      isStringArray(help.activities) &&
      isStringArray(help.blOperations) &&
      Array.isArray(help.images) &&
      help.images.every(
        (image) =>
          isRecord(image) &&
          isString(image.path) &&
          (image.caption === undefined || isString(image.caption)) &&
          isString(image.mimeType) &&
          isString(image.dataUrl)
      )
    );
  });
}

function hasCurrentSaturation(value: unknown): value is SaturationDocument {
  if (!isRecord(value) || !isRecord(value.defaults) || !Array.isArray(value.defaults.saturatedWhen)) return false;

  return value.defaults.saturatedWhen.every((rule) => {
    if (!isRecord(rule) || "instance_type" in rule) return false;
    return isString(rule.metric_id) && isString(rule.stat) && isFiniteNumber(rule.value);
  });
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

function sortPackages(packages: ImportedPackage[]): ImportedPackage[] {
  return [...packages].sort((a, b) => b.importedAt.localeCompare(a.importedAt));
}

export function isCurrentPackage(value: unknown): value is ImportedPackage {
  if (!isRecord(value)) return false;
  return (
    isString(value.id) &&
    isString(value.name) &&
    isString(value.importedAt) &&
    Array.isArray(value.scenarios) &&
    Array.isArray(value.configs) &&
    Array.isArray(value.tests) &&
    Array.isArray(value.runs) &&
    hasCurrentMetrics(value.metrics) &&
    hasCurrentTopology(value.topology) &&
    hasCurrentSaturation(value.saturation) &&
    hasCurrentMeasurements(value.measurements) &&
    (value.scenarioHelp === undefined || hasCurrentScenarioHelp(value.scenarioHelp))
  );
}

function parseStoredPackage(json: string): ImportedPackage | undefined {
  try {
    const parsed = JSON.parse(json);
    return isCurrentPackage(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

class BrowserStorage implements PerfexaStorage {
  async init() {
    return undefined;
  }

  async listPackages(): Promise<ImportedPackage[]> {
    return sortPackages(this.readAll());
  }

  async getPackage(id: string): Promise<ImportedPackage | undefined> {
    return this.readAll().find((pkg) => pkg.id === id);
  }

  async savePackage(pkg: ImportedPackage): Promise<void> {
    const next = this.readAll().filter((item) => item.id !== pkg.id);
    next.push(pkg);
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(sortPackages(next)));
  }

  async updatePackageNotes(id: string, notes: NotesDocument): Promise<void> {
    const pkg = await this.getPackage(id);
    if (!pkg) return;
    await this.savePackage({ ...pkg, notes });
  }

  private readAll(): ImportedPackage[] {
    try {
      const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
      if (!raw) return [];

      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        localStorage.removeItem(LOCAL_STORAGE_KEY);
        return [];
      }

      const packages = parsed.filter(isCurrentPackage);
      if (packages.length !== parsed.length) {
        localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(sortPackages(packages)));
      }
      return packages;
    } catch {
      localStorage.removeItem(LOCAL_STORAGE_KEY);
      return [];
    }
  }
}

class SqliteStorage implements PerfexaStorage {
  private constructor(private readonly db: SqlDatabase) {}

  static async open(): Promise<SqliteStorage> {
    const module = await import("@tauri-apps/plugin-sql");
    const Database = module.default;
    const db = (await Database.load("sqlite:perfexa.db")) as SqlDatabase;
    const storage = new SqliteStorage(db);
    await storage.init();
    return storage;
  }

  async init(): Promise<void> {
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS packages (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        imported_at TEXT NOT NULL,
        source_path TEXT,
        package_json TEXT NOT NULL
      )
    `);
    await this.migrateConfigsTableIfNeeded();
    await this.migrateTestsTableIfNeeded();
    await this.migrateRunsTableIfNeeded();
    await this.migrateMeasurementsTableIfNeeded();
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS scenarios (
        package_id TEXT NOT NULL,
        scenario_id TEXT NOT NULL,
        name TEXT NOT NULL,
        PRIMARY KEY (package_id, scenario_id)
      )
    `);
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS configs (
        package_id TEXT NOT NULL,
        config_id TEXT NOT NULL,
        exagon_ver TEXT NOT NULL,
        components_ver TEXT NOT NULL,
        PRIMARY KEY (package_id, config_id)
      )
    `);
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS tests (
        package_id TEXT NOT NULL,
        scenario_id TEXT NOT NULL,
        config_id TEXT NOT NULL,
        sequence_id INTEGER NOT NULL,
        PRIMARY KEY (package_id, scenario_id, config_id, sequence_id)
      )
    `);
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS runs (
        package_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        scenario_id TEXT NOT NULL,
        config_id TEXT NOT NULL,
        sequence_id INTEGER NOT NULL,
        target_tps REAL NOT NULL,
        started_at TEXT NOT NULL,
        duration TEXT NOT NULL,
        PRIMARY KEY (package_id, run_id)
      )
    `);
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS measurements (
        package_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        metric_id TEXT NOT NULL,
        stat TEXT NOT NULL,
        instance_id TEXT NOT NULL,
        value REAL NOT NULL
      )
    `);
  }

  async listPackages(): Promise<ImportedPackage[]> {
    const rows = await this.db.select<{ id: string; package_json: string }>(
      "SELECT id, package_json FROM packages ORDER BY imported_at DESC"
    );
    const packages: ImportedPackage[] = [];

    for (const row of rows) {
      const pkg = parseStoredPackage(row.package_json);
      if (pkg) {
        packages.push(pkg);
      } else {
        await this.deletePackage(row.id);
      }
    }

    return sortPackages(packages);
  }

  async getPackage(id: string): Promise<ImportedPackage | undefined> {
    const rows = await this.db.select<{ package_json: string }>(
      "SELECT package_json FROM packages WHERE id = ?",
      [id]
    );
    if (!rows[0]) return undefined;

    const pkg = parseStoredPackage(rows[0].package_json);
    if (!pkg) {
      await this.deletePackage(id);
    }
    return pkg;
  }

  async savePackage(pkg: ImportedPackage): Promise<void> {
    const packageJson = JSON.stringify(pkg);
    await this.db.execute("BEGIN");
    try {
      await this.db.execute(
        "INSERT OR REPLACE INTO packages (id, name, imported_at, source_path, package_json) VALUES (?, ?, ?, ?, ?)",
        [pkg.id, pkg.name, pkg.importedAt, pkg.sourcePath ?? null, packageJson]
      );
      await this.db.execute("DELETE FROM scenarios WHERE package_id = ?", [pkg.id]);
      await this.db.execute("DELETE FROM configs WHERE package_id = ?", [pkg.id]);
      await this.db.execute("DELETE FROM tests WHERE package_id = ?", [pkg.id]);
      await this.db.execute("DELETE FROM runs WHERE package_id = ?", [pkg.id]);
      await this.db.execute("DELETE FROM measurements WHERE package_id = ?", [pkg.id]);

      for (const scenario of pkg.scenarios) {
        await this.db.execute(
          "INSERT INTO scenarios (package_id, scenario_id, name) VALUES (?, ?, ?)",
          [pkg.id, scenario.scenario_id, scenario.name]
        );
      }

      for (const config of pkg.configs) {
        await this.db.execute(
          "INSERT INTO configs (package_id, config_id, exagon_ver, components_ver) VALUES (?, ?, ?, ?)",
          [pkg.id, config.config_id, config.exagon_ver, config.components_ver]
        );
      }

      for (const test of pkg.tests) {
        await this.db.execute(
          "INSERT INTO tests (package_id, scenario_id, config_id, sequence_id) VALUES (?, ?, ?, ?)",
          [pkg.id, test.scenario_id, test.config_id, test.sequence_id]
        );
      }

      for (const run of pkg.runs) {
        await this.db.execute(
          "INSERT INTO runs (package_id, run_id, scenario_id, config_id, sequence_id, target_tps, started_at, duration) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          [
            pkg.id,
            run.run_id,
            run.scenario_id,
            run.config_id,
            run.sequence_id,
            run.target_tps,
            run.started_at,
            run.duration
          ]
        );
      }

      for (const measurement of pkg.measurements) {
        await this.db.execute(
          "INSERT INTO measurements (package_id, run_id, metric_id, stat, instance_id, value) VALUES (?, ?, ?, ?, ?, ?)",
          [
            pkg.id,
            measurement.run_id,
            measurement.metric_id,
            measurement.stat,
            measurement.instance_id,
            measurement.value
          ]
        );
      }

      await this.db.execute("COMMIT");
    } catch (error) {
      await this.db.execute("ROLLBACK");
      throw error;
    }
  }

  private async migrateRunsTableIfNeeded(): Promise<void> {
    try {
      const columns = await this.db.select<{ name: string }>("PRAGMA table_info(runs)");
      if (columns.length === 0) return;
      const names = columns.map((column) => column.name);
      if (
        names.includes("test_id") ||
        !names.includes("scenario_id") ||
        !names.includes("config_id") ||
        !names.includes("sequence_id")
      ) {
        await this.db.execute("DROP TABLE IF EXISTS runs");
      }
    } catch {
      // A missing table is fine; the current schema will be created below.
    }
  }

  private async deletePackage(id: string): Promise<void> {
    await this.db.execute("DELETE FROM packages WHERE id = ?", [id]);
    await this.db.execute("DELETE FROM scenarios WHERE package_id = ?", [id]);
    await this.db.execute("DELETE FROM configs WHERE package_id = ?", [id]);
    await this.db.execute("DELETE FROM tests WHERE package_id = ?", [id]);
    await this.db.execute("DELETE FROM runs WHERE package_id = ?", [id]);
    await this.db.execute("DELETE FROM measurements WHERE package_id = ?", [id]);
  }

  private async migrateMeasurementsTableIfNeeded(): Promise<void> {
    try {
      const columns = await this.db.select<{ name: string }>("PRAGMA table_info(measurements)");
      if (columns.length === 0) return;
      const names = columns.map((column) => column.name);
      if (
        names.includes("instance_type") ||
        !names.includes("run_id") ||
        !names.includes("metric_id") ||
        !names.includes("stat") ||
        !names.includes("instance_id") ||
        !names.includes("value")
      ) {
        await this.db.execute("DROP TABLE IF EXISTS measurements");
      }
    } catch {
      // A missing table is fine; the current schema will be created below.
    }
  }

  private async migrateTestsTableIfNeeded(): Promise<void> {
    try {
      const columns = await this.db.select<{ name: string }>("PRAGMA table_info(tests)");
      if (columns.length === 0) return;
      const names = columns.map((column) => column.name);
      if (
        names.includes("test_id") ||
        names.includes("exagon_ver") ||
        names.includes("components_ver") ||
        !names.includes("config_id") ||
        !names.includes("sequence_id")
      ) {
        await this.db.execute("DROP TABLE IF EXISTS tests");
      }
    } catch {
      // A missing table is fine; the current schema will be created below.
    }
  }

  private async migrateConfigsTableIfNeeded(): Promise<void> {
    try {
      const columns = await this.db.select<{ name: string }>("PRAGMA table_info(configs)");
      if (columns.length === 0) return;
      const names = columns.map((column) => column.name);
      if (!names.includes("config_id") || !names.includes("exagon_ver") || !names.includes("components_ver")) {
        await this.db.execute("DROP TABLE IF EXISTS configs");
      }
    } catch {
      // A missing table is fine; the current schema will be created below.
    }
  }

  async updatePackageNotes(id: string, notes: NotesDocument): Promise<void> {
    const pkg = await this.getPackage(id);
    if (!pkg) return;
    await this.savePackage({ ...pkg, notes });
  }
}

export async function createStorage(): Promise<PerfexaStorage> {
  if (isTauriRuntime()) {
    try {
      return await SqliteStorage.open();
    } catch (error) {
      console.warn("Falling back to browser storage because SQLite could not be opened.", error);
    }
  }

  const storage = new BrowserStorage();
  await storage.init();
  return storage;
}
