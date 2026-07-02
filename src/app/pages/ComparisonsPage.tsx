import EChartsReact from "echarts-for-react";
import { Loader2, Save } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { StatusPill } from "../../components/StatusPill";
import { buildRunSummary, formatNumber, scenarioName, testForRun, type RunSummary } from "../../domain/selectors";
import { useAppState } from "../AppState";

function delta(candidate?: number, baseline?: number) {
  if (candidate === undefined || baseline === undefined) return { absolute: undefined, percent: undefined };
  const absolute = candidate - baseline;
  return {
    absolute,
    percent: baseline === 0 ? undefined : (absolute / baseline) * 100
  };
}

function DeltaCell({ candidate, baseline, unit }: { candidate?: number; baseline?: number; unit: string }) {
  const result = delta(candidate, baseline);
  const tone = result.absolute === undefined ? "neutral" : result.absolute >= 0 ? "info" : "warn";
  return (
    <StatusPill tone={tone}>
      {result.absolute === undefined
        ? "-"
        : `${formatNumber(result.absolute, 2)} ${unit} (${formatNumber(result.percent, 1)}%)`}
    </StatusPill>
  );
}

function ComparisonMetric({
  label,
  baseline,
  candidate,
  unit
}: {
  label: string;
  baseline?: number;
  candidate?: number;
  unit: string;
}) {
  return (
    <div className="comparison-metric">
      <span>{label}</span>
      <strong>{formatNumber(candidate, 2)} {unit}</strong>
      <small>baseline {formatNumber(baseline, 2)} {unit}</small>
      <DeltaCell baseline={baseline} candidate={candidate} unit={unit} />
    </div>
  );
}

export function ComparisonsPage() {
  const { activePackage, setView, updateActivePackageNotes } = useAppState();
  const [baselineRunId, setBaselineRunId] = useState("");
  const [candidateRunId, setCandidateRunId] = useState("");
  const [conclusion, setConclusion] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!activePackage) return;
    setBaselineRunId(activePackage.runs[0]?.run_id ?? "");
    setCandidateRunId(activePackage.runs[1]?.run_id ?? activePackage.runs[0]?.run_id ?? "");
  }, [activePackage?.id]);

  const baseline = useMemo<RunSummary | undefined>(() => {
    const run = activePackage?.runs.find((item) => item.run_id === baselineRunId);
    return activePackage && run ? buildRunSummary(activePackage, run) : undefined;
  }, [activePackage, baselineRunId]);

  const candidate = useMemo<RunSummary | undefined>(() => {
    const run = activePackage?.runs.find((item) => item.run_id === candidateRunId);
    return activePackage && run ? buildRunSummary(activePackage, run) : undefined;
  }, [activePackage, candidateRunId]);

  useEffect(() => {
    if (!activePackage) return;
    const note = activePackage.notes.comparisons.find(
      (item) => item.baseline_run_id === baselineRunId && item.candidate_run_id === candidateRunId
    );
    setConclusion(note?.conclusion ?? "");
  }, [activePackage, baselineRunId, candidateRunId]);

  if (!activePackage) {
    return (
      <div className="empty-page">
        <h1>No package selected</h1>
        <button className="button button-primary" type="button" onClick={() => setView("import")}>
          Import package
        </button>
      </div>
    );
  }

  const chartOption = {
    animation: false,
    tooltip: { trigger: "axis" },
    legend: { top: 0 },
    grid: { left: 56, right: 24, top: 44, bottom: 34 },
    xAxis: { type: "category", data: ["Effective TPS", "Latency p95", "Error %"] },
    yAxis: { type: "value" },
    series: [
      {
        name: baseline?.run_id ?? "baseline",
        type: "bar",
        data: [baseline?.effective_tps, baseline?.latency_p95, baseline?.error_rate]
      },
      {
        name: candidate?.run_id ?? "candidate",
        type: "bar",
        data: [candidate?.effective_tps, candidate?.latency_p95, candidate?.error_rate]
      }
    ]
  };

  async function saveConclusion() {
    const pkg = activePackage;
    if (!pkg) return;
    setSaving(true);
    try {
      const comparisons = pkg.notes.comparisons.filter(
        (item) => !(item.baseline_run_id === baselineRunId && item.candidate_run_id === candidateRunId)
      );
      if (conclusion.trim()) {
        comparisons.push({
          baseline_run_id: baselineRunId,
          candidate_run_id: candidateRunId,
          conclusion: conclusion.trim(),
          updated_at: new Date().toISOString()
        });
      }
      await updateActivePackageNotes({ ...pkg.notes, comparisons });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="page-stack">
      <header className="page-header">
        <div>
          <p className="eyebrow">Compare</p>
          <h1>Baseline and candidate</h1>
        </div>
        <button className="button" type="button" onClick={saveConclusion} disabled={saving}>
          {saving ? <Loader2 className="spin" size={17} /> : <Save size={17} />}
          {saving ? "Saving" : "Save note"}
        </button>
      </header>

      <section className="panel comparison-selectors">
        <label>
          Baseline
          <select value={baselineRunId} onChange={(event) => setBaselineRunId(event.target.value)}>
            {activePackage.runs.map((run) => (
              <option key={run.run_id} value={run.run_id}>
                {run.run_id} - {scenarioName(activePackage, testForRun(activePackage, run)?.scenario_id ?? "")} - {run.target_tps} TPS
              </option>
            ))}
          </select>
        </label>
        <label>
          Candidate
          <select value={candidateRunId} onChange={(event) => setCandidateRunId(event.target.value)}>
            {activePackage.runs.map((run) => (
              <option key={run.run_id} value={run.run_id}>
                {run.run_id} - {scenarioName(activePackage, testForRun(activePackage, run)?.scenario_id ?? "")} - {run.target_tps} TPS
              </option>
            ))}
          </select>
        </label>
      </section>

      <section className="comparison-grid">
        <ComparisonMetric
          label="Effective TPS"
          baseline={baseline?.effective_tps}
          candidate={candidate?.effective_tps}
          unit="tps"
        />
        <ComparisonMetric
          label="Latency p95"
          baseline={baseline?.latency_p95}
          candidate={candidate?.latency_p95}
          unit="ms"
        />
        <ComparisonMetric
          label="Error rate"
          baseline={baseline?.error_rate}
          candidate={candidate?.error_rate}
          unit="%"
        />
      </section>

      <section className="panel chart-panel">
        <EChartsReact option={chartOption} style={{ height: 300, width: "100%" }} />
      </section>

      <section className="panel notes-panel">
        <label>
          Human conclusion
          <textarea
            value={conclusion}
            onChange={(event) => setConclusion(event.target.value)}
            rows={6}
            placeholder="Document the trade-off, investigation result, or follow-up."
          />
        </label>
      </section>
    </div>
  );
}
