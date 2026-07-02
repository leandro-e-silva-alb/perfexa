import { AlertTriangle, CheckCircle2, FolderOpen, Loader2, Save, XCircle } from "lucide-react";
import { useRef, useState } from "react";
import { validateImportSource } from "../../domain/importContract";
import type { ImportFileSource, ImportValidationResult, ValidationIssue } from "../../domain/types";
import { DataTable } from "../../components/DataTable";
import { StatusPill, type StatusTone } from "../../components/StatusPill";
import { selectTauriFolderSource, sourceFromFileList } from "../importSources";
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
  "raw/"
];

export function ImportPage() {
  const inputRef = useRef<HTMLInputElement>(null);
  const { saveImportedPackage, storageReady } = useAppState();
  const [result, setResult] = useState<ImportValidationResult>();
  const [selectedSource, setSelectedSource] = useState<string>("No folder selected");
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);

  async function runValidation(source: ImportFileSource) {
    setBusy(true);
    setSelectedSource(source.sourcePath ?? source.rootName);
    try {
      setResult(await validateImportSource(source));
    } finally {
      setBusy(false);
    }
  }

  async function handleSelectFolder() {
    const tauriSource = await selectTauriFolderSource();
    if (tauriSource) {
      await runValidation(tauriSource);
      return;
    }
    inputRef.current?.click();
  }

  async function handleFileInput(files: FileList | null) {
    if (!files || files.length === 0) return;
    await runValidation(sourceFromFileList(files));
  }

  async function handleSave() {
    if (!result?.package) return;
    setSaving(true);
    try {
      await saveImportedPackage(result.package);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="page-stack">
      <header className="page-header">
        <div>
          <p className="eyebrow">Import</p>
          <h1>Validate and import a performance package</h1>
        </div>
        <div className="header-actions">
          <button className="button button-primary" type="button" onClick={handleSelectFolder} disabled={busy}>
            {busy ? <Loader2 className="spin" size={17} /> : <FolderOpen size={17} />}
            {busy ? "Validating" : "Select folder"}
          </button>
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
          ref={inputRef}
          type="file"
          multiple
          hidden
          onChange={(event) => handleFileInput(event.target.files)}
          {...{ webkitdirectory: "", directory: "" }}
        />
      </header>

      <section className="panel import-status">
        <div>
          <span className="label">Selected folder</span>
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
                header: "Coverage",
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
