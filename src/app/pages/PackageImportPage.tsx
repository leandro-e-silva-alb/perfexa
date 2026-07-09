import {
  AlertTriangle,
  CheckCircle2,
  FileArchive,
  FolderOpen,
  Github,
  KeyRound,
  Loader2,
  Save,
  Trash2,
  XCircle
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { validateImportSource } from "../../domain/importContract";
import { evaluateFeatureAvailability } from "../../domain/featureRegistry";
import type { ImportFileSource, ImportValidationResult, ValidationIssue } from "../../domain/types";
import { DataTable } from "../../components/DataTable";
import { StatusPill, type StatusTone } from "../../components/StatusPill";
import {
  selectTauriFolderSource,
  selectTauriZipSource,
  sourceFromFileList,
  sourceFromZipBytesAtPath,
  sourceFromZipFile
} from "../importSources";
import {
  clearGitHubToken,
  defaultGitHubImportConfig,
  downloadGitHubArchive,
  githubCredentialAccount,
  hasStoredGitHubToken,
  isTauriRuntime,
  saveGitHubToken,
  type GitHubImportConfig
} from "../githubImport";
import { useAppState } from "../AppState";

function featureTone(status: string): StatusTone {
  if (status === "available") return "ok";
  if (status === "partial") return "warn";
  return "bad";
}

interface IssueGroup {
  key: string;
  file: string;
  summary: string;
  count: number;
  locations: string[];
}

function parseIssuePath(issueItem: ValidationIssue): { row?: string; field?: string; location?: string } {
  if (!issueItem.path) return {};
  const file = issueItem.file;
  const withoutFile =
    file && issueItem.path.startsWith(`${file}:`)
      ? issueItem.path.slice(file.length + 1)
      : issueItem.path;
  const parts = withoutFile.split(":");

  if (parts.length >= 2 && /^\d+$/.test(parts[0])) {
    return {
      row: parts[0],
      field: parts.slice(1).join(":"),
      location: `row ${parts[0]}${parts.length > 1 ? `, ${parts.slice(1).join(":")}` : ""}`
    };
  }

  return { location: withoutFile };
}

function sampleLocations(locations: string[]): string {
  const unique = [...new Set(locations)].filter(Boolean);
  if (unique.length === 0) return "";
  const visible = unique.slice(0, 8).join("; ");
  const remaining = unique.length - 8;
  return remaining > 0 ? `${visible}; +${remaining} more` : visible;
}

function groupIssues(issues: ValidationIssue[]): IssueGroup[] {
  const groups = new Map<string, IssueGroup>();

  for (const issueItem of issues) {
    const file = issueItem.file ?? "import";
    const parsed = parseIssuePath(issueItem);
    const fieldPrefix = parsed.field ? `Column ${parsed.field}: ` : "";
    const summary = `${fieldPrefix}${issueItem.message}`;
    const key = `${file}|${summary}`;
    const existing =
      groups.get(key) ??
      ({
        key,
        file,
        summary,
        count: 0,
        locations: []
      } satisfies IssueGroup);

    existing.count += 1;
    if (parsed.location) existing.locations.push(parsed.location);
    groups.set(key, existing);
  }

  return [...groups.values()].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return `${a.file}${a.summary}`.localeCompare(`${b.file}${b.summary}`);
  });
}

function failedImportResult(file: string, message: string): ImportValidationResult {
  return {
    report: {
      valid: false,
      errors: [{ severity: "error", file, message }],
      warnings: [],
      features: evaluateFeatureAvailability([], [])
    }
  };
}

function readableErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function IssueList({ title, issues }: { title: string; issues: ValidationIssue[] }) {
  if (issues.length === 0) return null;
  const grouped = groupIssues(issues);
  const repeatedCount = issues.length - grouped.length;

  return (
    <section className="panel">
      <div className="panel-title">
        {issues[0].severity === "error" ? <XCircle size={18} /> : <AlertTriangle size={18} />}
        <h2>
          {title} <span className="panel-title-muted">{grouped.length} groups, {issues.length} total</span>
        </h2>
      </div>
      {repeatedCount > 0 ? (
        <p className="issue-summary">
          Collapsed {repeatedCount} repeated row-level issue{repeatedCount === 1 ? "" : "s"}.
        </p>
      ) : null}
      <ul className="issue-list issue-list-grouped">
        {grouped.map((group) => (
          <li key={group.key}>
            <div className="issue-row-main">
              <strong>{group.file}</strong>
              <span>{group.summary}</span>
              {group.count > 1 ? <em>{group.count} occurrences</em> : null}
            </div>
            {group.locations.length > 0 ? (
              <small>{sampleLocations(group.locations)}</small>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

const contractFiles = [
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
  "scenario-help.yaml (optional)",
  "raw/"
];

const githubConfigStorageKey = "perfexa.githubImportConfig.v1";

type TokenState = "checking" | "saved" | "missing" | "unavailable";

function loadGitHubConfig(): GitHubImportConfig {
  if (typeof localStorage === "undefined") return defaultGitHubImportConfig;
  try {
    const parsed = JSON.parse(localStorage.getItem(githubConfigStorageKey) ?? "{}") as Partial<GitHubImportConfig>;
    return {
      ...defaultGitHubImportConfig,
      ...parsed
    };
  } catch {
    return defaultGitHubImportConfig;
  }
}

export function PackageImportPage() {
  const folderInputRef = useRef<HTMLInputElement>(null);
  const zipInputRef = useRef<HTMLInputElement>(null);
  const { saveImportedPackage, storageReady } = useAppState();
  const [result, setResult] = useState<ImportValidationResult>();
  const [selectedSource, setSelectedSource] = useState<string>("No package selected");
  const [githubConfig, setGithubConfig] = useState<GitHubImportConfig>(() => loadGitHubConfig());
  const [githubToken, setGithubToken] = useState("");
  const [tokenState, setTokenState] = useState<TokenState>(isTauriRuntime() ? "checking" : "unavailable");
  const [saveError, setSaveError] = useState<string>();
  const [packageMenuOpen, setPackageMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const githubAccount = useMemo(() => githubCredentialAccount(githubConfig.apiBaseUrl), [githubConfig.apiBaseUrl]);

  useEffect(() => {
    localStorage.setItem(githubConfigStorageKey, JSON.stringify(githubConfig));
  }, [githubConfig]);

  useEffect(() => {
    let cancelled = false;
    if (!isTauriRuntime()) {
      setTokenState("unavailable");
      return;
    }

    setTokenState("checking");
    hasStoredGitHubToken(githubAccount)
      .then((hasToken) => {
        if (!cancelled) setTokenState(hasToken ? "saved" : "missing");
      })
      .catch(() => {
        if (!cancelled) setTokenState("missing");
      });

    return () => {
      cancelled = true;
    };
  }, [githubAccount]);

  async function runValidation(source: ImportFileSource) {
    setBusy(true);
    setSaveError(undefined);
    setSelectedSource(source.sourcePath ?? source.rootName);
    try {
      setResult(await validateImportSource(source));
    } finally {
      setBusy(false);
    }
  }

  async function handleSelectFolder() {
    setPackageMenuOpen(false);
    const tauriSource = await selectTauriFolderSource();
    if (tauriSource) {
      await runValidation(tauriSource);
      return;
    }
    folderInputRef.current?.click();
  }

  async function handleSelectZip() {
    setPackageMenuOpen(false);
    try {
      const tauriSource = await selectTauriZipSource();
      if (tauriSource) {
        await runValidation(tauriSource);
        return;
      }
      zipInputRef.current?.click();
    } catch (error) {
      setSelectedSource("Zip archive");
      setResult(failedImportResult("zip", `Unable to read zip archive: ${readableErrorMessage(error, "Invalid zip.")}`));
    }
  }

  async function handleFileInput(files: FileList | null) {
    if (!files || files.length === 0) return;
    await runValidation(sourceFromFileList(files));
  }

  async function handleZipFileInput(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    setBusy(true);
    setSelectedSource(file.name);
    try {
      const source = await sourceFromZipFile(file);
      setResult(await validateImportSource(source));
    } catch (error) {
      setResult(
        failedImportResult(file.name, `Unable to read zip archive: ${readableErrorMessage(error, "Invalid zip.")}`)
      );
    } finally {
      setBusy(false);
    }
  }

  function updateGitHubConfig<K extends keyof GitHubImportConfig>(key: K, value: GitHubImportConfig[K]) {
    setGithubConfig((current) => ({
      ...current,
      [key]: value
    }));
  }

  async function handleSaveGitHubToken() {
    setBusy(true);
    try {
      await saveGitHubToken(githubAccount, githubToken);
      setGithubToken("");
      setTokenState("saved");
    } catch (error) {
      setResult(
        failedImportResult(
          "github",
          `Unable to save GitHub token: ${readableErrorMessage(error, "Credential storage failed.")}`
        )
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleClearGitHubToken() {
    setBusy(true);
    try {
      await clearGitHubToken(githubAccount);
      setGithubToken("");
      setTokenState("missing");
    } catch (error) {
      setResult(
        failedImportResult(
          "github",
          `Unable to clear GitHub token: ${readableErrorMessage(error, "Credential removal failed.")}`
        )
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleImportFromGitHub() {
    setBusy(true);
    const label = `${githubConfig.owner}/${githubConfig.repo}/${githubConfig.refName}`;
    setSelectedSource(githubConfig.packagePath ? `${label}:${githubConfig.packagePath}` : label);
    try {
      const archive = await downloadGitHubArchive(githubAccount, githubConfig);
      const source = await sourceFromZipBytesAtPath(
        archive.archiveName,
        new Uint8Array(archive.bytes),
        githubConfig.packagePath,
        `${archive.sourceLabel}:${githubConfig.packagePath || "/"}`
      );
      setResult(await validateImportSource(source));
    } catch (error) {
      setResult(
        failedImportResult("github", `Unable to import from GitHub: ${readableErrorMessage(error, "Import failed.")}`)
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleSave() {
    if (!result?.package) return;
    setSaving(true);
    setSaveError(undefined);
    try {
      await saveImportedPackage(result.package);
    } catch (error) {
      setSaveError(readableErrorMessage(error, "The package could not be saved."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="page-stack">
      <header className="page-header">
        <div>
          <p className="eyebrow">Package Import</p>
          <h1>Validate and import a performance package</h1>
        </div>
        <div className="header-actions">
          <div className="package-picker">
            <button
              className="button button-primary"
              type="button"
              onClick={() => setPackageMenuOpen((open) => !open)}
              disabled={busy}
            >
              {busy ? <Loader2 className="spin" size={17} /> : <FolderOpen size={17} />}
              {busy ? "Validating" : "Select package"}
            </button>
            {packageMenuOpen ? (
              <div className="package-picker-menu">
                <button type="button" onClick={handleSelectFolder}>
                  <FolderOpen size={16} />
                  Folder
                </button>
                <button type="button" onClick={handleSelectZip}>
                  <FileArchive size={16} />
                  Zip archive
                </button>
              </div>
            ) : null}
          </div>
          <button
            className="button"
            type="button"
            onClick={handleSave}
            disabled={!result?.package || !storageReady || saving}
          >
            {saving ? <Loader2 className="spin" size={17} /> : <Save size={17} />}
            {saving ? "Saving" : "Accept import"}
          </button>
        </div>
        <input
          ref={folderInputRef}
          type="file"
          multiple
          hidden
          onChange={(event) => handleFileInput(event.target.files)}
          {...{ webkitdirectory: "", directory: "" }}
        />
        <input
          ref={zipInputRef}
          type="file"
          accept=".zip,application/zip,application/x-zip-compressed"
          hidden
          onChange={(event) => handleZipFileInput(event.target.files)}
        />
      </header>

      <section className="panel">
        <div className="panel-title">
          <Github size={18} />
          <h2>GitHub import</h2>
          <StatusPill tone={tokenState === "saved" ? "ok" : tokenState === "checking" ? "neutral" : "warn"}>
            {tokenState === "saved"
              ? "Token saved"
              : tokenState === "checking"
                ? "Checking token"
                : tokenState === "unavailable"
                  ? "Desktop only"
                  : "Token needed"}
          </StatusPill>
        </div>
        <div className="github-import-grid">
          <label>
            <span className="label">API URL</span>
            <input
              className="input"
              value={githubConfig.apiBaseUrl}
              onChange={(event) => updateGitHubConfig("apiBaseUrl", event.target.value)}
              placeholder="https://api.github.com"
            />
          </label>
          <label>
            <span className="label">Owner</span>
            <input
              className="input"
              value={githubConfig.owner}
              onChange={(event) => updateGitHubConfig("owner", event.target.value)}
              placeholder="organization"
            />
          </label>
          <label>
            <span className="label">Repository</span>
            <input
              className="input"
              value={githubConfig.repo}
              onChange={(event) => updateGitHubConfig("repo", event.target.value)}
              placeholder="repository"
            />
          </label>
          <label>
            <span className="label">Ref</span>
            <input
              className="input"
              value={githubConfig.refName}
              onChange={(event) => updateGitHubConfig("refName", event.target.value)}
              placeholder="main"
            />
          </label>
          <label className="github-import-wide">
            <span className="label">Package path</span>
            <input
              className="input"
              value={githubConfig.packagePath}
              onChange={(event) => updateGitHubConfig("packagePath", event.target.value)}
              placeholder="reports/latest/perf-import"
            />
          </label>
          <label className="github-import-wide">
            <span className="label">Token</span>
            <input
              className="input"
              type="password"
              value={githubToken}
              onChange={(event) => setGithubToken(event.target.value)}
              placeholder="Fine-grained token with Contents: read"
              disabled={tokenState === "unavailable"}
            />
          </label>
        </div>
        <div className="github-import-actions">
          <button
            className="button"
            type="button"
            onClick={handleSaveGitHubToken}
            disabled={busy || tokenState === "unavailable" || githubToken.trim().length === 0}
          >
            {busy ? <Loader2 className="spin" size={17} /> : <KeyRound size={17} />}
            Save token
          </button>
          <button
            className="button"
            type="button"
            onClick={handleClearGitHubToken}
            disabled={busy || tokenState !== "saved"}
          >
            <Trash2 size={17} />
            Clear token
          </button>
          <button
            className="button button-primary"
            type="button"
            onClick={handleImportFromGitHub}
            disabled={
              busy ||
              tokenState !== "saved" ||
              githubConfig.owner.trim().length === 0 ||
              githubConfig.repo.trim().length === 0 ||
              githubConfig.refName.trim().length === 0
            }
          >
            {busy ? <Loader2 className="spin" size={17} /> : <Github size={17} />}
            Import latest
          </button>
        </div>
      </section>

      <section className="panel import-status">
        <div>
          <span className="label">Selected package</span>
          <strong>{selectedSource}</strong>
        </div>
        <div>
          <span className="label">Validation</span>
          {result ? (
            <StatusPill tone={result.report.valid ? "ok" : "bad"}>
              {result.report.valid ? "Ready to import" : "Needs fixes"}
            </StatusPill>
          ) : (
            <StatusPill tone="neutral">Not run</StatusPill>
          )}
        </div>
        <div>
          <span className="label">Contract</span>
          <span>{contractFiles.join(", ")}</span>
        </div>
      </section>

      {result?.report.valid ? (
        <section className="panel success-panel">
          <CheckCircle2 size={20} />
          <div>
            <h2>Import contract accepted</h2>
            <p>
              {result.package?.runs.length ?? 0} runs, {result.package?.tests.length ?? 0} tests,{" "}
              {result.package?.configs.length ?? 0} configs,{" "}
              {result.package?.measurements.length ?? 0} measurements, {result.package?.scenarios.length ?? 0} scenarios.
            </p>
          </div>
        </section>
      ) : null}

      {saveError ? (
        <section className="panel save-error-panel">
          <XCircle size={20} />
          <div>
            <h2>Import was not saved</h2>
            <p>{saveError}</p>
          </div>
        </section>
      ) : null}

      {result ? (
        <section className="panel">
          <div className="panel-title">
            <CheckCircle2 size={18} />
            <h2>Feature availability</h2>
          </div>
          <DataTable
            compact
            searchPlaceholder="Filter features"
            data={result.report.features}
            columns={[
              {
                header: "Feature",
                accessorKey: "label"
              },
              {
                header: "Status",
                accessorKey: "status",
                cell: ({ row }) => (
                  <StatusPill tone={featureTone(row.original.status)}>{row.original.status}</StatusPill>
                )
              },
              {
                header: "Availability",
                cell: ({ row }) => `${row.original.presentCount}/${row.original.requiredCount}`
              },
              {
                header: "Missing",
                cell: ({ row }) => row.original.missing.join("; ") || "-"
              }
            ]}
          />
        </section>
      ) : null}

      <IssueList title="Validation errors" issues={result?.report.errors ?? []} />
      <IssueList title="Warnings" issues={result?.report.warnings ?? []} />
    </div>
  );
}

