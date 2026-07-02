import type { ConfigRecord, ImportedPackage, NotesDocument, RunRecord, TestRecord } from "../domain/types";

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

type LegacyComponent = {
  run_id: string;
  component_id: string;
  version: string;
};

type LegacyRun = Partial<RunRecord> & {
  run_id: string;
  test_id?: string;
  scenario?: string;
  short_name?: string;
  scenario_id?: string;
  config_id?: string;
  sequence_id?: number;
  exagon_ver?: string;
  target_tps: number;
  started_at: string;
  duration: string;
};

type LegacyTest = Partial<TestRecord> & {
  test_id?: string;
  scenario_id: string;
  config_id?: string;
  sequence_id?: number;
  exagon_ver?: string;
  components_ver?: string;
};

type LegacyPackage = Omit<ImportedPackage, "runs" | "tests" | "configs" | "components"> & {
  tests?: LegacyTest[];
  configs?: ConfigRecord[];
  components?: LegacyComponent[];
  runs: LegacyRun[];
};

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

function sortPackages(packages: ImportedPackage[]): ImportedPackage[] {
  return [...packages].sort((a, b) => b.importedAt.localeCompare(a.importedAt));
}

function testIdForLegacyRun(run: LegacyRun): string {
  return run.test_id ?? run.short_name ?? run.scenario_id ?? run.scenario ?? run.run_id;
}

function componentsVerForRun(components: LegacyComponent[] | undefined, runId: string): string {
  if (!components) return "";
  return components
    .filter((component) => component.run_id === runId && component.component_id !== "exagon")
    .map((component) => `${component.component_id}:${component.version}`)
    .join(",");
}

function legacyConfigIdForTest(test: LegacyTest): string {
  return test.config_id ?? test.test_id ?? test.scenario_id;
}

function legacyTestIdForTest(test: LegacyTest): string {
  return test.test_id ?? `${test.scenario_id}|${legacyConfigIdForTest(test)}|${test.sequence_id ?? 0}`;
}

function normalizePackage(raw: ImportedPackage): ImportedPackage {
  const legacy = raw as unknown as LegacyPackage;
  const legacyTests = legacy.tests ?? [];
  const sequenceByScenarioConfig = new Map<string, number>();
  const oldTestIdToTest = new Map<string, TestRecord>();
  const configsById = new Map<string, ConfigRecord>();

  for (const config of legacy.configs ?? []) {
    configsById.set(config.config_id, config);
  }

  const tests: TestRecord[] =
    legacyTests.length > 0
      ? legacyTests.map((test) => {
          const configId = legacyConfigIdForTest(test);
          const counterKey = `${test.scenario_id}|${configId}`;
          const sequenceId =
            typeof test.sequence_id === "number"
              ? test.sequence_id
              : sequenceByScenarioConfig.get(counterKey) ?? 0;
          sequenceByScenarioConfig.set(counterKey, Math.max(sequenceByScenarioConfig.get(counterKey) ?? 0, sequenceId + 1));

          if (!configsById.has(configId)) {
            configsById.set(configId, {
              config_id: configId,
              exagon_ver: test.exagon_ver ?? "",
              components_ver: test.components_ver ?? ""
            });
          }

          const normalized = {
            scenario_id: test.scenario_id,
            config_id: configId,
            sequence_id: sequenceId
          };
          oldTestIdToTest.set(legacyTestIdForTest(test), normalized);
          return normalized;
        })
      : [];

  if (tests.length === 0) {
    for (const run of legacy.runs) {
      const oldTestId = testIdForLegacyRun(run);
      const scenarioId = run.scenario_id ?? run.short_name ?? run.scenario ?? oldTestId;
      const configId = run.config_id ?? oldTestId;
      const counterKey = `${scenarioId}|${configId}`;
      const sequenceId =
        typeof run.sequence_id === "number" ? run.sequence_id : sequenceByScenarioConfig.get(counterKey) ?? 0;
      const normalized = {
        scenario_id: scenarioId,
        config_id: configId,
        sequence_id: sequenceId
      };

      if (!oldTestIdToTest.has(oldTestId)) {
        sequenceByScenarioConfig.set(counterKey, sequenceId + 1);
        oldTestIdToTest.set(oldTestId, normalized);
        tests.push(normalized);
      }

      if (!configsById.has(configId)) {
        configsById.set(configId, {
          config_id: configId,
          exagon_ver: run.exagon_ver ?? "",
          components_ver: componentsVerForRun(legacy.components, run.run_id)
        });
      }
    }
  }

  const scenarios =
    legacy.scenarios && legacy.scenarios.length > 0
      ? legacy.scenarios
      : [
          ...new Map(
            tests.map((test) => [
              test.scenario_id,
              {
                scenario_id: test.scenario_id,
                name:
                  legacy.runs.find((run) => oldTestIdToTest.get(testIdForLegacyRun(run))?.scenario_id === test.scenario_id)
                    ?.scenario ??
                  test.scenario_id
              }
            ])
          ).values()
        ];

  return {
    ...raw,
    scenarios,
    configs: [...configsById.values()],
    tests,
    runs: legacy.runs.map((run) => ({
      ...(oldTestIdToTest.get(testIdForLegacyRun(run)) ?? {
        scenario_id: run.scenario_id ?? run.short_name ?? run.scenario ?? testIdForLegacyRun(run),
        config_id: run.config_id ?? testIdForLegacyRun(run),
        sequence_id: run.sequence_id ?? 0
      }),
      run_id: run.run_id,
      target_tps: run.target_tps,
      started_at: run.started_at,
      duration: run.duration
    }))
  };
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
      return raw ? (JSON.parse(raw) as ImportedPackage[]).map(normalizePackage) : [];
    } catch {
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
        instance_type TEXT NOT NULL,
        instance_id TEXT NOT NULL,
        value REAL NOT NULL
      )
    `);
  }

  async listPackages(): Promise<ImportedPackage[]> {
    const rows = await this.db.select<{ package_json: string }>(
      "SELECT package_json FROM packages ORDER BY imported_at DESC"
    );
    return rows.map((row) => normalizePackage(JSON.parse(row.package_json) as ImportedPackage));
  }

  async getPackage(id: string): Promise<ImportedPackage | undefined> {
    const rows = await this.db.select<{ package_json: string }>(
      "SELECT package_json FROM packages WHERE id = ?",
      [id]
    );
    return rows[0] ? normalizePackage(JSON.parse(rows[0].package_json) as ImportedPackage) : undefined;
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
          "INSERT INTO measurements (package_id, run_id, metric_id, stat, instance_type, instance_id, value) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [
            pkg.id,
            measurement.run_id,
            measurement.metric_id,
            measurement.stat,
            measurement.instance_type,
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
