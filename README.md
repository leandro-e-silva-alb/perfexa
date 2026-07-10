# Perfexa

Perfexa is a local performance analysis app for importing benchmark result packages, exploring metrics by topology level, checking saturation, comparing runs, and fitting CPU regressions per test.

It is built with React, Vite, TypeScript, ECharts, and Tauri.

## Requirements

- Node.js and npm
- Rust toolchain, required for the Tauri desktop app
- Windows WebView2 runtime, normally already installed on modern Windows

## Getting Started

Install dependencies:

```powershell
npm install
```

Run the web app in a browser:

```powershell
npm run dev
```

Then open:

```text
http://127.0.0.1:1420
```

Run the app as a native Windows desktop window:

```powershell
npm run tauri dev
```

The Tauri dev command starts the Vite dev server automatically and opens the Perfexa window.

## Important Commands

Run tests:

```powershell
npm test
```

Build the frontend:

```powershell
npm run build
```

Preview the production frontend build:

```powershell
npm run preview
```

Run Tauri commands:

```powershell
npm run tauri -- <command>
```

Build the desktop app bundle:

```powershell
npm run tauri build
```

## Import Package Format

Perfexa imports either a folder or a `.zip` archive containing headered CSV and YAML files. The fixture folders under `fixtures/` are the best examples:

```text
fixtures/perf-import
fixtures/real-perf-import
```

An import package is expected to include these files at the package root. Zip archives may put them directly at the archive root or inside one wrapping folder:

```text
manifest.yaml
metrics.yaml
topology.yaml
saturation.yaml
notes.yaml
scenarios.csv
configs.csv
tests.csv
runs.csv
measurements.csv
```

Each CSV table may also be split into additional root-level fragments whose
filename ends with a dot plus the canonical table name. For example,
`part2.runs.csv` is merged into `runs.csv`, and `extra.configs.csv` is merged
into `configs.csv`. The canonical files listed above are still required, and
validation runs over the merged rows.

Key CSV identities:

- `tests.csv` is the planned scenario/config catalog and is identified by `scenario_id` and `config_id`.
- `runs.csv` is the execution source of truth and includes `run_id`, `scenario_id`, `config_id`, `sequence_id`, `target_tps`, timing, and duration data.
- Measurements use `run_id`, `metric_id`, `stat`, `instance_id`, and `value`.

Topology is configured in `topology.yaml` using layers and nodes. Metrics are configured in `metrics.yaml`; metrics without a `topology` block are raw metrics, and metrics with a `topology` block can be projected through topology levels.

```yaml
cpu:
  unit: mCPU
  description: CPU usage.
  topology:
    aggregation: sum
latency:
  unit: ms
  description: Request latency.
```

Supported topology aggregation rules are `sum`, `average`, `ratio`, `percentage`, and `max`. Weighted rules use `topology.weight`.

## GitHub Import

The desktop app can import the latest package from a private GitHub repository without storing the token in app storage. On the Import page, save a fine-grained GitHub token with `Contents: read`; Perfexa stores it in the OS credential store for the configured GitHub API host.

Set the owner, repository, branch or ref, and nested package path. `Import latest` downloads the repository archive for that ref, reads the package from the configured nested path, validates it, and then lets you accept it into the local library.

## Useful Fixture Workflow

Start the app:

```powershell
npm run tauri dev
```

Use the Import page and select one of the fixture folders:

```text
fixtures/perf-import
fixtures/real-perf-import
```

After import, use the Library, Overview, Metrics, Regression, and Comparisons pages to inspect the package.

## Notes

- The desktop app stores imported packages in the local Tauri SQLite database.
- The browser dev app falls back to browser storage when Tauri APIs are unavailable.
- CPU regression requires a `cpu` metric in `metrics.yaml` with `topology.aggregation: sum`.
- Topology unknown values are controlled by `unknownValues` in `topology.yaml`: `strict`, `permissive`, or `ignore`.
