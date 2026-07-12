import EChartsReact from "echarts-for-react";
import { Activity, Calculator, ChevronLeft, ChevronRight, Cpu, Gauge, GitCompare, Plus, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { StatusPill } from "../../components/StatusPill";
import {
  buildCpuSizingModelAnalyses,
  predictCpu,
  type CpuSizingModelAnalysis,
  type SizingModelChartPoint
} from "../../domain/sizingModels";
import { useAppState } from "../AppState";

type FitReadyAnalysis = CpuSizingModelAnalysis & {
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

function testLabel(row: CpuSizingModelAnalysis): string {
  return `${row.scenario} / ${row.exagonVersion} / #${row.sequenceId}`;
}

function isFitReady(row: CpuSizingModelAnalysis): row is FitReadyAnalysis {
  return (
    row.idle !== null &&
    row.marginalCpu !== null &&
    row.transientOverhead !== null &&
    row.halfSaturationK !== null &&
    row.rSquared !== null &&
    row.rmse !== null
  );
}

function predictedCpuCores(row: CpuSizingModelAnalysis, effectiveTps: number): number | null {
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

function makeCurve(row: CpuSizingModelAnalysis, maxTps: number): Array<[number, number]> {
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

function tpsForCpuCores(row: CpuSizingModelAnalysis, cpuCores: number): number | null {
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
  points: SizingModelChartPoint[],
  value: (point: SizingModelChartPoint) => number | undefined
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
    <section className="panel chart-panel test-compare-chart-panel">
      <div className="panel-title">
        {icon}
        <h2>{title}</h2>
      </div>
      {children}
    </section>
  );
}

export function TestComparePage() {
  const { activePackage, comparisonTestKeys, setComparisonTestKeys, setView } = useAppState();
  const [draftTestKey, setDraftTestKey] = useState("");
  const [tpsInput, setTpsInput] = useState("1");
  const [cpuInput, setCpuInput] = useState("10");
  const initializedPackageId = useRef<string>();
  const detailCarouselRef = useRef<HTMLDivElement>(null);
  const detailCarouselSyncTimeoutRef = useRef<number | undefined>();
  const suppressDetailCarouselScrollSyncRef = useRef(false);
  const [activeDetailIndex, setActiveDetailIndex] = useState(0);

  const analyses = useMemo(
    () => (activePackage ? buildCpuSizingModelAnalyses(activePackage) : []),
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
        .filter((analysis): analysis is CpuSizingModelAnalysis => Boolean(analysis)),
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

  useEffect(() => {
    suppressDetailCarouselScrollSyncRef.current = false;
    clearPendingDetailCarouselSync();
    setActiveDetailIndex((current) => Math.min(current, Math.max(selectedTests.length - 1, 0)));
  }, [selectedTests.length]);

  useEffect(() => {
    return () => {
      clearPendingDetailCarouselSync();
    };
  }, []);

  function clearPendingDetailCarouselSync() {
    if (detailCarouselSyncTimeoutRef.current !== undefined) {
      window.clearTimeout(detailCarouselSyncTimeoutRef.current);
      detailCarouselSyncTimeoutRef.current = undefined;
    }
  }

  function syncDetailCarouselIndex() {
    if (suppressDetailCarouselScrollSyncRef.current) {
      return;
    }

    const carousel = detailCarouselRef.current;
    if (!carousel) return;

    const cards = [...carousel.querySelectorAll<HTMLElement>(".test-compare-chart-panel")];
    if (cards.length === 0) return;

    const carouselCenter = carousel.scrollLeft + carousel.clientWidth / 2;
    const nearest = cards.reduce(
      (best, card, index) => {
        const cardCenter = card.offsetLeft + card.offsetWidth / 2;
        const distance = Math.abs(cardCenter - carouselCenter);
        return distance < best.distance ? { index, distance } : best;
      },
      { index: 0, distance: Number.POSITIVE_INFINITY }
    );

    setActiveDetailIndex(nearest.index);
  }

  function scheduleDetailCarouselSync() {
    clearPendingDetailCarouselSync();
    detailCarouselSyncTimeoutRef.current = window.setTimeout(() => {
      suppressDetailCarouselScrollSyncRef.current = false;
      detailCarouselSyncTimeoutRef.current = undefined;
      syncDetailCarouselIndex();
    }, 420);
  }

  function scrollToDetailChart(index: number) {
    const carousel = detailCarouselRef.current;
    const card = carousel?.querySelectorAll<HTMLElement>(".test-compare-chart-panel")[index];
    if (!card) return;

    suppressDetailCarouselScrollSyncRef.current = true;
    setActiveDetailIndex(index);
    card.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "start" });
    scheduleDetailCarouselSync();
  }

  function scrollDetailCarouselBy(delta: number) {
    const nextIndex = Math.min(Math.max(activeDetailIndex + delta, 0), selectedTests.length - 1);
    if (nextIndex === activeDetailIndex) return;
    scrollToDetailChart(nextIndex);
  }

  function handleDetailCarouselKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (selectedTests.length <= 1) return;

    if (event.key === "ArrowLeft") {
      event.preventDefault();
      scrollDetailCarouselBy(-1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      scrollDetailCarouselBy(1);
    } else if (event.key === "Home") {
      event.preventDefault();
      scrollToDetailChart(0);
    } else if (event.key === "End") {
      event.preventDefault();
      scrollToDetailChart(selectedTests.length - 1);
    }
  }

  if (!activePackage) {
    return (
      <div className="empty-page">
        <h1>No package selected</h1>
        <button className="button button-primary" type="button" onClick={() => setView("package-import")}>
          Package Import
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
  const canMoveDetailPrevious = activeDetailIndex > 0;
  const canMoveDetailNext = activeDetailIndex < selectedTests.length - 1;

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
  const cpuSizingModelOption = {
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
    { label: "Scenario", value: (row: CpuSizingModelAnalysis) => row.scenario },
    { label: "Exagon version", value: (row: CpuSizingModelAnalysis) => row.exagonVersion },
    { label: "Base CPU (idle)", value: (row: CpuSizingModelAnalysis) => formatFixed(row.idle, 6) },
    { label: "Incremental CPU (L)", value: (row: CpuSizingModelAnalysis) => formatFixed(row.marginalCpu, 9) },
    { label: "Transient CPU overhead (extra)", value: (row: CpuSizingModelAnalysis) => formatFixed(row.transientOverhead, 6) },
    { label: "Overhead half-saturation const. (k)", value: (row: CpuSizingModelAnalysis) => formatFixed(row.halfSaturationK, 6) },
    { label: "R2", value: (row: CpuSizingModelAnalysis) => formatFixed(row.rSquared, 9) },
    { label: "RMSE", value: (row: CpuSizingModelAnalysis) => formatFixed(row.rmse, 4) },
    { label: "Points Fitted/Total", value: (row: CpuSizingModelAnalysis) => `${row.fittedPoints}/${row.totalPoints}` },
    {
      label: "Avg latency",
      value: (row: CpuSizingModelAnalysis) => {
        const value = average(row.points.map((point) => point.latencyAvg).filter((item): item is number => item !== undefined));
        return value === null ? "-" : `${formatFixed(value, 2)} ms`;
      }
    },
    {
      label: "Max throttling",
      value: (row: CpuSizingModelAnalysis) => {
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
          <p className="eyebrow">Test Compare</p>
          <h1>Test model comparison</h1>
          <span className="header-meta">{activePackage.name}</span>
        </div>
        <StatusPill tone={fitReadyCount > 0 ? "ok" : "warn"}>
          {selectedTests.length} selected / {fitReadyCount} fitted
        </StatusPill>
      </header>

      <section className="panel test-compare-selector-panel">
        <div className="test-compare-selector-controls">
          <label className="test-compare-test-picker">
            <span className="test-compare-filter-label">
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

        <div className="test-compare-chip-row">
          {selectedTests.length === 0 ? (
            <span className="test-compare-empty-selection">No tests selected</span>
          ) : (
            selectedTests.map((test, index) => (
              <button
                className="test-compare-test-chip"
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

      <ChartPanel icon={<Cpu size={17} aria-hidden="true" />} title="CPU vs TPS model">
        <EChartsReact option={cpuSizingModelOption} notMerge lazyUpdate style={{ height: 380, width: "100%" }} />
      </ChartPanel>

      <div className="test-compare-two-column">
        <ChartPanel icon={<Gauge size={17} aria-hidden="true" />} title="Average latency">
          <EChartsReact option={latencyOption} notMerge lazyUpdate style={{ height: 320, width: "100%" }} />
        </ChartPanel>
        <ChartPanel icon={<Activity size={17} aria-hidden="true" />} title="Max throttling">
          <EChartsReact option={throttlingOption} notMerge lazyUpdate style={{ height: 320, width: "100%" }} />
        </ChartPanel>
      </div>

      <section className="panel test-compare-model-metrics-panel">
        <div className="panel-title">
          <GitCompare size={17} aria-hidden="true" />
          <h2>Model metrics</h2>
        </div>
        <div className="test-compare-model-metrics-wrap">
          <table className="test-compare-model-metrics-table">
            <thead>
              <tr>
                <th>Metric</th>
                {selectedTests.map((test, index) => (
                  <th key={test.testKey}>
                    <span className="test-compare-column-heading">
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

      <div
        className="test-compare-detail-carousel"
        role="region"
        aria-label="Per-test CPU charts"
        aria-keyshortcuts="ArrowLeft ArrowRight Home End"
        onKeyDown={handleDetailCarouselKeyDown}
      >
        <div
          className="test-compare-detail-grid"
          ref={detailCarouselRef}
          tabIndex={0}
          onScroll={syncDetailCarouselIndex}
        >
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
                  name: "Model",
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
        {selectedTests.length > 1 ? (
          <div className="test-compare-carousel-controls" aria-label="Per-test chart navigation">
            <button
              type="button"
              className="test-compare-carousel-arrow"
              aria-label="Previous chart"
              aria-disabled={!canMoveDetailPrevious}
              onClick={() => {
                if (canMoveDetailPrevious) scrollDetailCarouselBy(-1);
              }}
            >
              <ChevronLeft size={16} aria-hidden="true" />
            </button>
            <div className="test-compare-carousel-dots">
              {selectedTests.map((test, index) => (
                <button
                  key={test.testKey}
                  type="button"
                  className={index === activeDetailIndex ? "selected" : ""}
                  aria-label={`Show ${testLabel(test)}`}
                  aria-current={index === activeDetailIndex ? "true" : undefined}
                  onClick={() => scrollToDetailChart(index)}
                />
              ))}
            </div>
            <button
              type="button"
              className="test-compare-carousel-arrow"
              aria-label="Next chart"
              aria-disabled={!canMoveDetailNext}
              onClick={() => {
                if (canMoveDetailNext) scrollDetailCarouselBy(1);
              }}
            >
              <ChevronRight size={16} aria-hidden="true" />
            </button>
          </div>
        ) : null}
      </div>

      <section className="panel test-compare-calculator-panel">
        <div className="panel-title">
          <Calculator size={17} aria-hidden="true" />
          <h2>Calculator</h2>
        </div>
        <div className="test-compare-calculator-wrap">
          <table className="test-compare-calculator-table">
            <thead>
              <tr>
                <th>Mode</th>
                <th>Input</th>
                {selectedTests.map((test, index) => (
                  <th key={test.testKey}>
                    <span className="test-compare-column-heading">
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
                  <label className="test-compare-inline-input">
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
                  <label className="test-compare-inline-input">
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

