import { ArrowDownAZ, ArrowDownZA, CircleHelp } from "lucide-react";
import { useMemo, useState } from "react";
import { HelpModal } from "../../components/HelpModal";
import { StatusPill } from "../../components/StatusPill";
import {
  buildCoverageMatrix,
  formatDateTime,
  formatNumber,
  type CoverageMatrixCell,
  type CoverageMatrixConfig
} from "../../domain/selectors";
import type { ScenarioHelpEntry } from "../../domain/types";
import { useAppState } from "../AppState";

type ScenarioSortDirection = "asc" | "desc";

function cellTone(cell: CoverageMatrixCell): string {
  if (!cell.planned) return "coverage-cell-unplanned";
  return cell.runCount > 0 ? "coverage-cell-covered" : "coverage-cell-pending";
}

function cellTitle(cell: CoverageMatrixCell, config: CoverageMatrixConfig | undefined): string {
  const configLabel = config?.label ?? cell.config_id;
  if (!cell.planned) return `${cell.scenario_id} / ${configLabel}: not planned`;
  if (cell.runCount === 0) return `${cell.scenario_id} / ${configLabel}: planned, not executed`;
  return `${cell.scenario_id} / ${configLabel}: ${cell.runCount} executed`;
}

function ScenarioHelpContent({ help }: { help: ScenarioHelpEntry }) {
  const categories = [
    { label: "Microservices", items: help.microservices },
    { label: "Sagas", items: help.sagas },
    { label: "Activities", items: help.activities },
    { label: "BL operations", items: help.blOperations }
  ].filter((category) => category.items.length > 0);

  return (
    <div className="scenario-help-content">
      {help.body ? <p className="scenario-help-body">{help.body}</p> : null}

      {categories.length > 0 ? (
        <div className="scenario-help-category-grid">
          {categories.map((category) => (
            <section className="scenario-help-category" key={category.label}>
              <h3>{category.label}</h3>
              <ul>
                {category.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      ) : null}

      {help.images.length > 0 ? (
        <div className="scenario-help-images">
          {help.images.map((image) => (
            <figure className="scenario-help-figure" key={image.path}>
              <img src={image.dataUrl} alt={image.caption ?? image.path} />
              {image.caption ? <figcaption>{image.caption}</figcaption> : null}
            </figure>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function CoveragePage() {
  const { activePackage, setView } = useAppState();
  const [selectedHelpScenarioId, setSelectedHelpScenarioId] = useState<string | undefined>();
  const [scenarioSortDirection, setScenarioSortDirection] = useState<ScenarioSortDirection>("asc");
  const matrix = useMemo(
    () => (activePackage ? buildCoverageMatrix(activePackage) : undefined),
    [activePackage]
  );
  const sortedRows = useMemo(() => {
    if (!matrix) return [];

    return [...matrix.rows].sort((left, right) => {
      const comparison =
        left.scenario_name.localeCompare(right.scenario_name, undefined, { numeric: true }) ||
        left.scenario_id.localeCompare(right.scenario_id, undefined, { numeric: true });
      return scenarioSortDirection === "asc" ? comparison : -comparison;
    });
  }, [matrix, scenarioSortDirection]);

  if (!activePackage || !matrix) {
    return (
      <div className="empty-page">
        <h1>No package selected</h1>
        <button className="button button-primary" type="button" onClick={() => setView("import")}>
          Import package
        </button>
      </div>
    );
  }

  const coveragePercent =
    matrix.plannedPairs === 0 ? 0 : Math.round((matrix.coveredPairs / matrix.plannedPairs) * 100);
  const coverageTone = matrix.pendingPairs === 0 && matrix.plannedPairs > 0 ? "ok" : "warn";
  const helpByScenario = activePackage.scenarioHelp?.scenarios ?? {};
  const selectedScenarioHelp = selectedHelpScenarioId ? helpByScenario[selectedHelpScenarioId] : undefined;
  const ScenarioSortIcon = scenarioSortDirection === "asc" ? ArrowDownAZ : ArrowDownZA;
  const nextScenarioSortDirection = scenarioSortDirection === "asc" ? "Z-A" : "A-Z";

  return (
    <div className="page-stack page-stack-wide">
      <header className="page-header">
        <div>
          <p className="eyebrow">Coverage</p>
          <h1>{activePackage.name}</h1>
          <span className="header-meta">Imported {formatDateTime(activePackage.importedAt)}</span>
        </div>
        <StatusPill tone={coverageTone}>{coveragePercent}% covered</StatusPill>
      </header>

      <section className="panel coverage-panel">
        <div className="panel-title coverage-title">
          <h2>Scenario / config matrix</h2>
          <div className="coverage-legend" aria-label="Coverage legend">
            <span>
              <i className="coverage-token coverage-token-covered">N</i>
              Executed
            </span>
            <span>
              <i className="coverage-token coverage-token-pending">0</i>
              Pending
            </span>
            <span>
              <i className="coverage-token coverage-token-unplanned">-</i>
              Not planned
            </span>
          </div>
        </div>

        <div className="coverage-table-wrap">
          <table className="coverage-table">
            <thead>
              <tr>
                <th
                  className="coverage-scenario-head"
                  rowSpan={2}
                  aria-sort={scenarioSortDirection === "asc" ? "ascending" : "descending"}
                >
                  <button
                    className="coverage-scenario-sort"
                    type="button"
                    title={`Sort scenarios ${nextScenarioSortDirection}`}
                    aria-label={`Sort scenarios ${nextScenarioSortDirection}`}
                    onClick={() =>
                      setScenarioSortDirection((current) => (current === "asc" ? "desc" : "asc"))
                    }
                  >
                    <span>Scenario</span>
                    <span className="coverage-scenario-sort-mark">
                      <ScenarioSortIcon size={15} aria-hidden="true" />
                      {scenarioSortDirection === "asc" ? "A-Z" : "Z-A"}
                    </span>
                  </button>
                </th>
                {matrix.configGroups.map((group) => (
                  <th
                    className="coverage-config-patch-head"
                    key={group.versionPatch}
                    colSpan={group.colSpan}
                    scope="colgroup"
                  >
                    {group.versionPatch}
                  </th>
                ))}
              </tr>
              <tr>
                {matrix.configs.map((config) => (
                  <th
                    className="coverage-config-version-head"
                    key={config.config_id}
                    scope="col"
                    title={config.componentSummary}
                  >
                    <span className="coverage-config-heading">
                      <strong>{config.label}</strong>
                      {config.rcSummary ? <small className="coverage-rc-tag">{config.rcSummary}</small> : null}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sortedRows.length === 0 || matrix.configs.length === 0 ? (
                <tr>
                  <td className="empty-cell" colSpan={Math.max(1, matrix.configs.length + 1)}>
                    No scenarios or configs
                  </td>
                </tr>
              ) : (
                sortedRows.map((row) => {
                  const scenarioHelp = helpByScenario[row.scenario_id];

                  return (
                    <tr key={row.scenario_id}>
                      <th scope="row">
                        <span className="coverage-scenario-row-heading">
                          <span className="coverage-scenario-heading">
                            <strong>{row.scenario_name}</strong>
                          </span>
                          {scenarioHelp ? (
                            <button
                              className="icon-button coverage-scenario-help-button"
                              type="button"
                              title={`Show help for ${row.scenario_name}`}
                              aria-label={`Show help for ${row.scenario_name}`}
                              onClick={() => setSelectedHelpScenarioId(row.scenario_id)}
                            >
                              <CircleHelp size={15} />
                            </button>
                          ) : null}
                        </span>
                      </th>
                      {row.cells.map((cell, configIndex) => {
                        const config = matrix.configs[configIndex];

                        return (
                          <td
                            key={`${cell.scenario_id}:${cell.config_id}`}
                            className={cellTone(cell)}
                            title={cellTitle(cell, config)}
                          >
                            <span className="coverage-cell-value">
                              {cell.value === "-" ? "-" : formatNumber(cell.value, 0)}
                            </span>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      <HelpModal
        open={Boolean(selectedScenarioHelp)}
        title={selectedScenarioHelp?.title ?? "Scenario help"}
        className="scenario-help-modal"
        contentClassName="scenario-help-modal-content"
        closeLabel="Close scenario help"
        onClose={() => setSelectedHelpScenarioId(undefined)}
      >
        {selectedScenarioHelp ? <ScenarioHelpContent help={selectedScenarioHelp} /> : null}
      </HelpModal>
    </div>
  );
}
