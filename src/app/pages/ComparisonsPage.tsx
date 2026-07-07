import EChartsReact from "echarts-for-react";
import { Activity, Calculator, Cpu, Gauge, GitCompare, Plus, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { StatusPill } from "../../components/StatusPill";
import {
  buildCpuRegressionAnalyses,
  predictCpu,
  type CpuRegressionAnalysis,
  type RegressionChartPoint
} from "../../domain/regression";
import { useAppState } from "../AppState";

type FitReadyAnalysis = CpuRegressionAnalysis & {
  idle: number;
  marginalCpu: number;
  transientOverhead: number;
  halfSaturationK: number;
  rSquared: number;
  rmse: number;
};

const palette = [
  "#0f7f7a",
  "#d97706",
  "#2563eb",
  "#b42318",
  "#1f7a4d",
  "#7c3aed",
  "#475569",
  "#be123c"
];

function formatFixed(value: number | null | undefined, digits: number): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "-";
  }

  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  }).format(value);
}

function formatCompact(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "-";
  }

  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: digits
  }).format(value);
}

function testLabel(row: CpuRegressionAnalysis): string {
  return `${row.scenario} / ${row.exagonVersion} / #${row.sequenceId}`;
}

function isFitReady(row: CpuRegressionAnalysis): row is FitReadyAnalysis {
  return (
    row.idle !== null &&
    row.marginalCpu !== null &&
    row.transientOverhead !== null &&
    row.halfSaturationK !== null &&
    row.rSquared !== null &&
    row.rmse !== null
  );
}

function predictedCpuCores(row: CpuRegressionAnalysis, effectiveTps: number): number | null {
  if (!isFitReady(row)) {
    return null;
  }

  return (
    predictCpu(
      effectiveTps,
      row.idle,
      row.marginalCpu,
      row.transientOverhead,
      row.halfSaturationK
    ) / 1000
  );
}

function makeCurve(row: CpuRegressionAnalysis, maxTps: number): Array<[number, number]> {
  if (!isFitReady(row)) {
    return [];
  }

  const safeMax = Math.max(maxTps, ...row.points.map((point) => point.effectiveTps), 1);
  const samples = 90;
  return Array.from({ length: samples }, (_, index) => {
    const tps = (safeMax * index) / (samples - 1);
    return [tps, predictedCpuCores(row, tps) ?? 0];
  });
}

function average(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function maxValue(values: number[]): number | null {
  return values.length === 0 ? null : Math.max(...values);
}

function parsePositiveInput(value: string): number | null {
  const parsed = Number(value.replace(",", "."));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function tpsForCpuCores(row: CpuRegressionAnalysis, cpuCores: number): number | null {
  if (!isFitReady(row)) {
    return null;
  }

  const targetMcpu = cpuCores * 1000;
  if (targetMcpu <= row.idle) {
    return 0;
  }

  let high = Math.max(
    1,
    row.halfSaturationK * 2,
    ...row.points.map((point) => point.effectiveTps * 2)
  );
  let predictedHigh = predictCpu(high, row.idle, row.marginalCpu, row.transientOverhead, row.halfSaturationK);

  for (let guard = 0; guard < 80 && predictedHigh < targetMcpu; guard += 1) {
    high *= 2;
    predictedHigh = predictCpu(high, row.idle, row.marginalCpu, row.transientOverhead, row.halfSaturationK);
    if (high > 1_000_000_000) {
      return null;
    }
  }

  if (predictedHigh < targetMcpu) {
    return null;
  }

  let low = 0;
  for (let iteration = 0; iteration < 80; iteration += 1) {
    const mid = (low + high) / 2;
    const predictedMid = predictCpu(mid, row.idle, row.marginalCpu, row.transientOverhead, row.halfSaturationK);
    if (predictedMid < targetMcpu) {
      low = mid;
    } else {
      high = mid;
    }
  }

  return high;
}

function pointData(
  points: RegressionChartPoint[],
  value: (point: RegressionChartPoint) => number | undefined
): Array<[number, number, string]> {
  return points
    .map((point): [number, number, string] | null => {
      const y = value(point);
      return y === undefined ? null : [point.effectiveTps, y, point.runId];
    })
    .filter((point): point is [number, number, string] => point !== null);
}

function ChartPanel({
  children,
  icon,
  title
}: {
  children: ReactNode;
  icon: ReactNode;
  title: string;
}) {
  return (
    <section className="panel chart-panel compare-chart-panel">
      <div className="panel-title">
        {icon}
        <h2>{title}</h2>
      </div>
      {children}
    </section>
  );
}

export function ComparisonsPage() {
  const { activePackage, comparisonTestKeys, setComparisonTestKeys, setView } = useAppState();
  const [draftTestKey, setDraftTestKey] = useState("");
  const [tpsInput, setTpsInput] = useState("1");
  const [cpuInput, setCpuInput] = useState("10");
  const initializedPackageId = useRef<string>();

  const analyses = useMemo(
    () => (activePackage ? buildCpuRegressionAnalyses(activePackage) : []),
    [activePackage]
  );
  const analysisByKey = useMemo(
    () => new Map(analyses.map((analysis) => [analysis.testKey, analysis])),
    [analyses]
  );
  const selectedTests = useMemo(
    () =>
      comparisonTestKeys
        .map((key) => analysisByKey.get(key))
        .filter((analysis): analysis is CpuRegressionAnalysis => Boolean(analysis)),
    [analysisByKey, comparisonTestKeys]
  );
  const selectedKeySet = useMemo(
    () => new Set(selectedTests.map((test) => test.testKey)),
    [selectedTests]
  );
  const availableTests = useMemo(
    () => analyses.filter((analysis) => !selectedKeySet.has(analysis.testKey)),
    [analyses, selectedKeySet]
  );

  useEffect(() => {
    if (!activePackage || analyses.length === 0) {
      return;
    }

    const validKeys = comparisonTestKeys.filter((key) => analysisByKey.has(key));
    const packageChanged = initializedPackageId.current !== activePackage.id;

    if (packageChanged) {
      initializedPackageId.current = activePackage.id;
    }

    const nextKeys =
      packageChanged && validKeys.length === 0
        ? analyses.slice(0, Math.min(2, analyses.length)).map((analysis) => analysis.testKey)
        : validKeys;

    if (nextKeys.join("\n") !== comparisonTestKeys.join("\n")) {
      setComparisonTestKeys(nextKeys);
    }
  }, [activePackage, analyses, analysisByKey, comparisonTestKeys, setComparisonTestKeys]);

  useEffect(() => {
    setDraftTestKey((current) =>
      current && availableTests.some((test) => test.testKey === current)
        ? current
        : availableTests[0]?.testKey ?? ""
    );
  }, [availableTests]);

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

  const maxSelectedTps = Math.max(
    1,
    ...selectedTests.flatMap((test) => test.points.map((point) => point.effectiveTps))
  );
  const fitReadyCount = selectedTests.filter(isFitReady).length;
  const tpsValue = parsePositiveInput(tpsInput);
  const cpuValue = parsePositiveInput(cpuInput);

  const sharedLegend = {
    type: "scroll",
    top: 0,
    textStyle: { color: "#3a424b" }
  };
  const sharedGrid = { left: 18, right: 26, top: 58, bottom: 48, containLabel: true };
  const sharedTooltip = {
    trigger: "axis",
    confine: true,
    axisPointer: { type: "cross" }
  };
  const cpuRegressionOption = {
    animation: true,
    tooltip: sharedTooltip,
    legend: sharedLegend,
    grid: sharedGrid,
    xAxis: {
      type: "value",
      name: "Effective TPS",
      nameLocation: "middle",
      nameGap: 28,
      min: 0
    },
    yAxis: {
      type: "value",
      name: "CPU",
      nameGap: 28
    },
    series: selectedTests
      .map((test, index) =>
        isFitReady(test)
          ? {
              name: testLabel(test),
              type: "line",
              showSymbol: false,
              smooth: true,
              color: palette[index % palette.length],
              lineStyle: { width: 2.4 },
              data: makeCurve(test, maxSelectedTps * 1.05)
            }
          : null
      )
      .filter((series): series is NonNullable<typeof series> => series !== null)
  };
  const latencyOption = {
    animation: true,
    tooltip: sharedTooltip,
    legend: sharedLegend,
    grid: sharedGrid,
    xAxis: {
      type: "value",
      name: "Effective TPS",
      nameLocation: "middle",
      nameGap: 28,
      min: 0
    },
    yAxis: {
      type: "value",
      name: "ms",
      nameGap: 26
    },
    series: selectedTests.map((test, index) => ({
      name: testLabel(test),
      type: "line",
      showSymbol: true,
      symbolSize: 7,
      color: palette[index % palette.length],
      data: pointData(test.points, (point) => point.latencyAvg)
    }))
  };
  const throttlingOption = {
    animation: true,
    tooltip: sharedTooltip,
    legend: sharedLegend,
    grid: sharedGrid,
    xAxis: {
      type: "value",
      name: "Effective TPS",
      nameLocation: "middle",
      nameGap: 28,
      min: 0
    },
    yAxis: {
      type: "value",
      name: "%",
      nameGap: 26
    },
    series: selectedTests.map((test, index) => ({
      name: testLabel(test),
      type: "line",
      showSymbol: true,
      symbolSize: 7,
      color: palette[index % palette.length],
      data: pointData(test.points, (point) => point.maxThrottling)
    }))
  };
  const metricsRows = [
    { label: "Scenario", value: (row: CpuRegressionAnalysis) => row.scenario },
    { label: "Exagon version", value: (row: CpuRegressionAnalysis) => row.exagonVersion },
    { label: "Config ID", value: (row: CpuRegressionAnalysis) => row.configId },
    { label: "Base CPU (idle)", value: (row: CpuRegressionAnalysis) => formatFixed(row.idle, 6) },
    { label: "Marginal CPU (L)", value: (row: CpuRegressionAnalysis) => formatFixed(row.marginalCpu, 9) },
    { label: "Transient overhead (extra)", value: (row: CpuRegressionAnalysis) => formatFixed(row.transientOverhead, 6) },
    { label: "Overhead half-saturation const. (k)", value: (row: CpuRegressionAnalysis) => formatFixed(row.halfSaturationK, 6) },
    { label: "R2", value: (row: CpuRegressionAnalysis) => formatFixed(row.rSquared, 9) },
    { label: "RMSE", value: (row: CpuRegressionAnalysis) => formatFixed(row.rmse, 4) },
    { label: "Points Fitted/Total", value: (row: CpuRegressionAnalysis) => `${row.fittedPoints}/${row.totalPoints}` },
    {
      label: "Avg latency",
      value: (row: CpuRegressionAnalysis) => {
        const value = average(row.points.map((point) => point.latencyAvg).filter((item): item is number => item !== undefined));
        return value === null ? "-" : `${formatFixed(value, 2)} ms`;
      }
    },
    {
      label: "Max throttling",
      value: (row: CpuRegressionAnalysis) => {
        const value = maxValue(row.points.map((point) => point.maxThrottling).filter((item): item is number => item !== undefined));
        return value === null ? "-" : `${formatFixed(value, 2)}%`;
      }
    }
  ];

  function addSelectedTest() {
    if (!draftTestKey) {
      return;
    }

    setComparisonTestKeys([...comparisonTestKeys, draftTestKey]);
  }

  function removeSelectedTest(testKey: string) {
    setComparisonTestKeys(comparisonTestKeys.filter((key) => key !== testKey));
  }

  function selectAllFittedTests() {
    setComparisonTestKeys(analyses.filter(isFitReady).map((analysis) => analysis.testKey));
  }

  return (
    <div className="page-stack page-stack-wide">
      <header className="page-header">
        <div>
          <p className="eyebrow">Compare</p>
          <h1>Test regression comparison</h1>
          <span className="header-meta">{activePackage.name}</span>
        </div>
        <StatusPill tone={fitReadyCount > 0 ? "ok" : "warn"}>
          {selectedTests.length} selected / {fitReadyCount} fitted
        </StatusPill>
      </header>

      <section className="panel compare-selector-panel">
        <div className="compare-selector-controls">
          <label className="compare-test-picker">
            <span className="metrics-filter-label">
              <GitCompare size={15} aria-hidden="true" />
              Test
            </span>
            <select
              value={draftTestKey}
              onChange={(event) => setDraftTestKey(event.target.value)}
              disabled={availableTests.length === 0}
            >
              {availableTests.length === 0 ? (
                <option value="">All tests selected</option>
              ) : (
                availableTests.map((test) => (
                  <option key={test.testKey} value={test.testKey}>
                    {testLabel(test)}
                  </option>
                ))
              )}
            </select>
          </label>
          <button className="button" type="button" onClick={addSelectedTest} disabled={!draftTestKey}>
            <Plus size={16} aria-hidden="true" />
            Add
          </button>
          <button className="button" type="button" onClick={selectAllFittedTests} disabled={analyses.every((test) => !isFitReady(test))}>
            <Activity size={16} aria-hidden="true" />
            Fitted
          </button>
          <button className="button" type="button" onClick={() => setComparisonTestKeys([])} disabled={selectedTests.length === 0}>
            <Trash2 size={16} aria-hidden="true" />
            Clear
          </button>
        </div>

        <div className="compare-chip-row">
          {selectedTests.length === 0 ? (
            <span className="compare-empty-selection">No tests selected</span>
          ) : (
            selectedTests.map((test, index) => (
              <button
                className="compare-test-chip"
                key={test.testKey}
                type="button"
                onClick={() => removeSelectedTest(test.testKey)}
                title="Remove test"
              >
                <span style={{ background: palette[index % palette.length] }} />
                {testLabel(test)}
                <X size={14} aria-hidden="true" />
              </button>
            ))
          )}
        </div>
      </section>

      <ChartPanel icon={<Cpu size={17} aria-hidden="true" />} title="CPU vs TPS regression">
        <EChartsReact option={cpuRegressionOption} notMerge lazyUpdate style={{ height: 380, width: "100%" }} />
      </ChartPanel>

      <div className="compare-two-column">
        <ChartPanel icon={<Gauge size={17} aria-hidden="true" />} title="Average latency">
          <EChartsReact option={latencyOption} notMerge lazyUpdate style={{ height: 320, width: "100%" }} />
        </ChartPanel>
        <ChartPanel icon={<Activity size={17} aria-hidden="true" />} title="Max throttling">
          <EChartsReact option={throttlingOption} notMerge lazyUpdate style={{ height: 320, width: "100%" }} />
        </ChartPanel>
      </div>

      <section className="panel compare-metrics-panel">
        <div className="panel-title">
          <GitCompare size={17} aria-hidden="true" />
          <h2>Metrics</h2>
        </div>
        <div className="compare-metrics-wrap">
          <table className="compare-metrics-table">
            <thead>
              <tr>
                <th>Metric</th>
                {selectedTests.map((test, index) => (
                  <th key={test.testKey}>
                    <span className="compare-column-heading">
                      <i style={{ background: palette[index % palette.length] }} />
                      {testLabel(test)}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {metricsRows.map((metric) => (
                <tr key={metric.label}>
                  <th>{metric.label}</th>
                  {selectedTests.map((test) => (
                    <td key={`${metric.label}:${test.testKey}`}>{metric.value(test)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="compare-detail-grid">
        {selectedTests.map((test, index) => {
          const color = palette[index % palette.length];
          const actualData = test.points.map((point): [number, number, string] => [
            point.effectiveTps,
            point.cpuMcpu / 1000,
            point.runId
          ]);
          const fittedData = test.points
            .filter((point) => point.fitted)
            .map((point): [number, number, string] => [point.effectiveTps, point.cpuMcpu / 1000, point.runId]);
          const option = {
            animation: true,
            tooltip: sharedTooltip,
            legend: {
              top: 0,
              textStyle: { color: "#3a424b" }
            },
            grid: sharedGrid,
            xAxis: {
              type: "value",
              name: "Effective TPS",
              nameLocation: "middle",
              nameGap: 28,
              min: 0
            },
            yAxis: {
              type: "value",
              name: "CPU",
              nameGap: 28
            },
            series: [
              {
                name: "Actual",
                type: "line",
                showSymbol: true,
                symbolSize: 7,
                color,
                lineStyle: { width: 2.2 },
                data: actualData
              },
              {
                name: "Fit points",
                type: "scatter",
                symbol: "emptyCircle",
                symbolSize: 14,
                color,
                itemStyle: {
                  borderColor: color,
                  borderWidth: 2.2
                },
                data: fittedData
              },
              {
                name: "Regression",
                type: "line",
                showSymbol: false,
                smooth: true,
                color,
                lineStyle: { type: "dashed", width: 2.2 },
                data: makeCurve(test, maxSelectedTps * 1.05)
              }
            ]
          };

          return (
            <ChartPanel key={test.testKey} icon={<Cpu size={17} aria-hidden="true" />} title={testLabel(test)}>
              <EChartsReact option={option} notMerge lazyUpdate style={{ height: 320, width: "100%" }} />
            </ChartPanel>
          );
        })}
      </div>

      <section className="panel compare-calculator-panel">
        <div className="panel-title">
          <Calculator size={17} aria-hidden="true" />
          <h2>Calculator</h2>
        </div>
        <div className="compare-calculator-wrap">
          <table className="compare-calculator-table">
            <thead>
              <tr>
                <th>Mode</th>
                <th>Input</th>
                {selectedTests.map((test, index) => (
                  <th key={test.testKey}>
                    <span className="compare-column-heading">
                      <i style={{ background: palette[index % palette.length] }} />
                      {testLabel(test)}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <th>Sizing: CPU(TPS)</th>
                <td>
                  <label className="compare-inline-input">
                    <input
                      value={tpsInput}
                      onChange={(event) => setTpsInput(event.target.value)}
                      inputMode="decimal"
                    />
                    <span>TPS</span>
                  </label>
                </td>
                {selectedTests.map((test) => {
                  const cpu = tpsValue === null ? null : predictedCpuCores(test, tpsValue);
                  return <td key={`cpu:${test.testKey}`}>{cpu === null ? "-" : `${formatFixed(cpu, 2)} CPU`}</td>;
                })}
              </tr>
              <tr>
                <th>Throughput: TPS(CPU)</th>
                <td>
                  <label className="compare-inline-input">
                    <input
                      value={cpuInput}
                      onChange={(event) => setCpuInput(event.target.value)}
                      inputMode="decimal"
                    />
                    <span>CPU</span>
                  </label>
                </td>
                {selectedTests.map((test) => {
                  const tps = cpuValue === null ? null : tpsForCpuCores(test, cpuValue);
                  return <td key={`tps:${test.testKey}`}>{tps === null ? "-" : `${formatCompact(tps, 2)} TPS`}</td>;
                })}
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
