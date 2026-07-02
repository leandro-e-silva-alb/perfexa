import type { ColumnDef, SortingState } from "@tanstack/react-table";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Columns3,
  Filter,
  GripVertical,
  Layers,
  Search,
  X
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { DataTable } from "../../components/DataTable";
import { StatusPill } from "../../components/StatusPill";
import { buildRunSummaries, formatDateTime, formatNumber, type RunSummary } from "../../domain/selectors";
import { useAppState } from "../AppState";

type FilterSectionKey = "scenario" | "test" | "exagon" | "targetTps" | "saturation";
type GroupBy = "none" | "scenario" | "test" | "exagon" | "targetTps" | "saturation";
type OverviewColumnId =
  | "scenario"
  | "exagon"
  | "targetTps"
  | "effectiveTps"
  | "latencyAvg"
  | "latencyP95"
  | "errorRate"
  | "saturation"
  | "versions"
  | "started";

interface OverviewFilters {
  scenarioIds: string[];
  testKeys: string[];
  exagonVers: string[];
  targetTps: string[];
  saturation: "all" | "saturated" | "clear";
}

interface FilterOption {
  value: string;
  label: string;
  count: number;
}

interface FilterSection {
  key: FilterSectionKey;
  label: string;
  options: FilterOption[];
  selectedCount: number;
}

interface OverviewColumn {
  id: OverviewColumnId;
  label: string;
  column: ColumnDef<RunSummary>;
}

const emptyFilters: OverviewFilters = {
  scenarioIds: [],
  testKeys: [],
  exagonVers: [],
  targetTps: [],
  saturation: "all"
};

const groupOptions: Array<{ value: GroupBy; label: string }> = [
  { value: "none", label: "No grouping" },
  { value: "scenario", label: "Scenario" },
  { value: "test", label: "Test" },
  { value: "exagon", label: "Exagon version" },
  { value: "targetTps", label: "Target TPS" },
  { value: "saturation", label: "Saturation" }
];

const allColumnIds: OverviewColumnId[] = [
  "scenario",
  "exagon",
  "targetTps",
  "effectiveTps",
  "latencyAvg",
  "errorRate",
  "saturation",
  "started",
  "latencyP95",
  "versions"
];

const defaultColumnIds: OverviewColumnId[] = [
  "scenario",
  "exagon",
  "targetTps",
  "effectiveTps",
  "latencyAvg",
  "errorRate",
  "saturation",
  "started"
];

function toggleValue(values: string[], value: string): string[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

function optionsFromRows(
  rows: RunSummary[],
  getValue: (row: RunSummary) => string,
  getLabel: (row: RunSummary) => string
): FilterOption[] {
  const options = new Map<string, FilterOption>();
  for (const row of rows) {
    const value = getValue(row);
    if (!value) continue;
    const existing = options.get(value);
    if (existing) {
      existing.count += 1;
    } else {
      options.set(value, { value, label: getLabel(row), count: 1 });
    }
  }

  return [...options.values()].sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
}

export function OverviewPage() {
  const { activePackage, setView } = useAppState();
  const [query, setQuery] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [groupOpen, setGroupOpen] = useState(false);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [activeFilter, setActiveFilter] = useState<FilterSectionKey>("scenario");
  const [optionSearch, setOptionSearch] = useState("");
  const [columnSearch, setColumnSearch] = useState("");
  const [groupBy, setGroupBy] = useState<GroupBy>("none");
  const [collapsedGroups, setCollapsedGroups] = useState<string[]>([]);
  const [columnOrder, setColumnOrder] = useState<OverviewColumnId[]>(allColumnIds);
  const [visibleColumnIds, setVisibleColumnIds] = useState<OverviewColumnId[]>(defaultColumnIds);
  const [draggedColumnId, setDraggedColumnId] = useState<OverviewColumnId>();
  const [filters, setFilters] = useState<OverviewFilters>(emptyFilters);

  const rows = useMemo(
    () => (activePackage ? buildRunSummaries(activePackage) : []),
    [activePackage]
  );

  useEffect(() => {
    setQuery("");
    setFilters(emptyFilters);
    setFiltersOpen(false);
    setGroupOpen(false);
    setColumnsOpen(false);
    setColumnSearch("");
    setGroupBy("none");
    setCollapsedGroups([]);
  }, [activePackage?.id]);

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

  const activeFilterCount =
    filters.scenarioIds.length +
    filters.testKeys.length +
    filters.exagonVers.length +
    filters.targetTps.length +
    (filters.saturation === "all" ? 0 : 1);

  const filterSections: FilterSection[] = [
    {
      key: "scenario",
      label: "Scenario",
      selectedCount: filters.scenarioIds.length,
      options: optionsFromRows(rows, (row) => row.scenario_id, (row) => row.scenario_name)
    },
    {
      key: "test",
      label: "Test",
      selectedCount: filters.testKeys.length,
      options: optionsFromRows(rows, (row) => row.test_key, (row) => row.test_name)
    },
    {
      key: "exagon",
      label: "Exagon version",
      selectedCount: filters.exagonVers.length,
      options: optionsFromRows(rows, (row) => row.exagon_ver, (row) => row.exagon_ver)
    },
    {
      key: "targetTps",
      label: "Target TPS",
      selectedCount: filters.targetTps.length,
      options: optionsFromRows(rows, (row) => String(row.target_tps), (row) => `${formatNumber(row.target_tps, 0)} TPS`)
    },
    {
      key: "saturation",
      label: "Saturation",
      selectedCount: filters.saturation === "all" ? 0 : 1,
      options: [
        {
          value: "clear",
          label: "Clear",
          count: rows.filter((row) => !row.saturation.saturated).length
        },
        {
          value: "saturated",
          label: "Saturated",
          count: rows.filter((row) => row.saturation.saturated).length
        }
      ]
    }
  ];

  const selectedSection = filterSections.find((section) => section.key === activeFilter) ?? filterSections[0];
  const visibleOptions = selectedSection.options.filter((option) =>
    option.label.toLowerCase().includes(optionSearch.trim().toLowerCase())
  );

  function optionLabel(sectionKey: FilterSectionKey, value: string): string {
    return filterSections.find((section) => section.key === sectionKey)?.options.find((option) => option.value === value)?.label ?? value;
  }

  function chipLabel(sectionKey: FilterSectionKey, values: string[]): string {
    const labels = values.map((value) => optionLabel(sectionKey, value));
    return labels.length <= 2 ? labels.join(", ") : `${labels.length} selected`;
  }

  function isOptionSelected(sectionKey: FilterSectionKey, value: string): boolean {
    if (sectionKey === "scenario") return filters.scenarioIds.includes(value);
    if (sectionKey === "test") return filters.testKeys.includes(value);
    if (sectionKey === "exagon") return filters.exagonVers.includes(value);
    if (sectionKey === "targetTps") return filters.targetTps.includes(value);
    return filters.saturation === value;
  }

  function toggleFilterOption(sectionKey: FilterSectionKey, value: string): void {
    setFilters((current) => {
      if (sectionKey === "scenario") return { ...current, scenarioIds: toggleValue(current.scenarioIds, value) };
      if (sectionKey === "test") return { ...current, testKeys: toggleValue(current.testKeys, value) };
      if (sectionKey === "exagon") return { ...current, exagonVers: toggleValue(current.exagonVers, value) };
      if (sectionKey === "targetTps") return { ...current, targetTps: toggleValue(current.targetTps, value) };
      return {
        ...current,
        saturation: current.saturation === value ? "all" : (value as OverviewFilters["saturation"])
      };
    });
  }

  function clearAllFilters(): void {
    setFilters(emptyFilters);
    setQuery("");
    setOptionSearch("");
  }

  function toggleColumn(columnId: OverviewColumnId): void {
    setVisibleColumnIds((current) => {
      if (current.includes(columnId)) {
        return current.length === 1 ? current : current.filter((id) => id !== columnId);
      }

      return [...current, columnId];
    });
  }

  function moveColumn(columnId: OverviewColumnId, targetColumnId: OverviewColumnId): void {
    if (columnId === targetColumnId) return;
    setColumnOrder((current) => {
      const next = current.filter((id) => id !== columnId);
      const targetIndex = next.indexOf(targetColumnId);
      if (targetIndex === -1) return current;
      next.splice(targetIndex, 0, columnId);
      return next;
    });
  }

  function moveColumnByOffset(columnId: OverviewColumnId, offset: number): void {
    setColumnOrder((current) => {
      const currentIndex = current.indexOf(columnId);
      const targetIndex = currentIndex + offset;
      if (currentIndex === -1 || targetIndex < 0 || targetIndex >= current.length) return current;
      const next = [...current];
      const [moved] = next.splice(currentIndex, 1);
      next.splice(targetIndex, 0, moved);
      return next;
    });
  }

  const filteredRows = rows.filter((row) => {
    if (filters.scenarioIds.length > 0 && !filters.scenarioIds.includes(row.scenario_id)) return false;
    if (filters.testKeys.length > 0 && !filters.testKeys.includes(row.test_key)) return false;
    if (filters.exagonVers.length > 0 && !filters.exagonVers.includes(row.exagon_ver)) return false;
    if (filters.targetTps.length > 0 && !filters.targetTps.includes(String(row.target_tps))) return false;
    if (filters.saturation === "saturated" && !row.saturation.saturated) return false;
    if (filters.saturation === "clear" && row.saturation.saturated) return false;

    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return true;

    return [
      row.test_name,
      row.scenario_name,
      row.exagon_ver,
      row.versions,
      row.duration,
      String(row.target_tps)
    ]
      .join(" ")
      .toLowerCase()
      .includes(normalizedQuery);
  });

  const groupedRows = (() => {
    if (groupBy === "none") return [];

    const groups = new Map<string, { key: string; label: string; rows: RunSummary[] }>();
    for (const row of filteredRows) {
      const group =
        groupBy === "scenario"
          ? { key: row.scenario_id, label: row.scenario_name }
          : groupBy === "test"
            ? { key: row.test_key, label: row.test_name }
            : groupBy === "exagon"
              ? { key: row.exagon_ver, label: row.exagon_ver }
              : groupBy === "targetTps"
                ? { key: String(row.target_tps), label: `${formatNumber(row.target_tps, 0)} TPS` }
                : {
                    key: row.saturation.saturated ? "saturated" : "clear",
                    label: row.saturation.saturated ? "Saturated" : "Clear"
                  };

      const existing = groups.get(group.key);
      if (existing) {
        existing.rows.push(row);
      } else {
        groups.set(group.key, { ...group, rows: [row] });
      }
    }

    return [...groups.values()].sort((a, b) =>
      groupBy === "targetTps"
        ? Number(a.key) - Number(b.key)
        : a.label.localeCompare(b.label, undefined, { numeric: true })
    );
  })();

  const filterChips = [
    filters.scenarioIds.length
      ? {
          key: "scenario",
          label: `Scenario: ${chipLabel("scenario", filters.scenarioIds)}`,
          onClear: () => setFilters((current) => ({ ...current, scenarioIds: [] }))
        }
      : undefined,
    filters.testKeys.length
      ? {
          key: "test",
          label: `Test: ${chipLabel("test", filters.testKeys)}`,
          onClear: () => setFilters((current) => ({ ...current, testKeys: [] }))
        }
      : undefined,
    filters.exagonVers.length
      ? {
          key: "exagon",
          label: `Exagon: ${chipLabel("exagon", filters.exagonVers)}`,
          onClear: () => setFilters((current) => ({ ...current, exagonVers: [] }))
        }
      : undefined,
    filters.targetTps.length
      ? {
          key: "targetTps",
          label: `Target TPS: ${chipLabel("targetTps", filters.targetTps)}`,
          onClear: () => setFilters((current) => ({ ...current, targetTps: [] }))
        }
      : undefined,
    filters.saturation !== "all"
      ? {
          key: "saturation",
          label: `Saturation: ${optionLabel("saturation", filters.saturation)}`,
          onClear: () => setFilters((current) => ({ ...current, saturation: "all" }))
        }
      : undefined
  ].filter(Boolean) as Array<{ key: string; label: string; onClear: () => void }>;

  const selectedGroupLabel = groupOptions.find((option) => option.value === groupBy)?.label ?? "No grouping";
  const overviewInitialSorting: SortingState = [{ id: "scenario", desc: true }];

  const columnDefinitions: OverviewColumn[] = [
    { id: "scenario", label: "Scenario", column: { id: "scenario", header: "Scenario", accessorKey: "scenario_name" } },
    { id: "exagon", label: "Exagon Version", column: { id: "exagon", header: "Exagon Version", accessorKey: "exagon_ver" } },
    { id: "targetTps", label: "Target TPS", column: { id: "targetTps", header: "Target TPS", accessorKey: "target_tps" } },
    {
      id: "effectiveTps",
      label: "Effective TPS",
      column: {
        id: "effectiveTps",
        header: "Effective TPS",
        cell: ({ row }) => formatNumber(row.original.effective_tps, 1)
      }
    },
    {
      id: "latencyAvg",
      label: "Latency avg",
      column: {
        id: "latencyAvg",
        header: "Latency avg",
        cell: ({ row }) => formatNumber(row.original.latency_avg, 1)
      }
    },
    {
      id: "errorRate",
      label: "Error %",
      column: {
        id: "errorRate",
        header: "Error %",
        cell: ({ row }) => formatNumber(row.original.error_rate, 3)
      }
    },
    {
      id: "saturation",
      label: "Saturation",
      column: {
        id: "saturation",
        header: "Saturation",
        cell: ({ row }) => (
          <StatusPill tone={row.original.saturation.saturated ? "warn" : "ok"}>
            {row.original.saturation.saturated ? "saturated" : "clear"}
          </StatusPill>
        )
      }
    },
    {
      id: "started",
      label: "Started",
      column: {
        id: "started",
        header: "Started",
        accessorKey: "started_at",
        cell: ({ row }) => formatDateTime(row.original.started_at)
      }
    },
    {
      id: "latencyP95",
      label: "Latency p95",
      column: {
        id: "latencyP95",
        header: "Latency p95",
        cell: ({ row }) => formatNumber(row.original.latency_p95, 1)
      }
    },
    { id: "versions", label: "Versions", column: { id: "versions", header: "Versions", accessorKey: "versions" } },
  ];
  const columnDefinitionMap = new Map(columnDefinitions.map((column) => [column.id, column]));
  const orderedColumnDefinitions = columnOrder
    .map((id) => columnDefinitionMap.get(id))
    .filter(Boolean) as OverviewColumn[];
  const columns = orderedColumnDefinitions
    .filter((column) => visibleColumnIds.includes(column.id))
    .map((column) => column.column);
  const visibleColumnOptions = orderedColumnDefinitions.filter((column) =>
    column.label.toLowerCase().includes(columnSearch.trim().toLowerCase())
  );

  const saturated = rows.filter((row) => row.saturation.saturated).length;
  const testCount = new Set(rows.map((row) => row.test_key)).size;

  return (
    <div className="page-stack">
      <header className="page-header">
        <div>
          <p className="eyebrow">Overview</p>
          <h1>{activePackage.name}</h1>
        </div>
        <span className="header-meta">Imported {formatDateTime(activePackage.importedAt)}</span>
      </header>

      <section className="metric-strip">
        <div className="metric-tile">
          <span>Runs</span>
          <strong>{rows.length}</strong>
        </div>
        <div className="metric-tile">
          <span>Tests</span>
          <strong>{testCount}</strong>
        </div>
        <div className="metric-tile">
          <span>Saturated</span>
          <strong>{saturated}</strong>
        </div>
        <div className="metric-tile">
          <span>Measurements</span>
          <strong>{activePackage.measurements.length}</strong>
        </div>
      </section>

      <section className="panel overview-results-panel">
        <div className="overview-workbar">
          <label className="overview-search" aria-label="Search overview runs">
            <Search size={16} aria-hidden="true" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search runs, scenarios, versions"
            />
          </label>

          <div className="overview-action-host">
            <button
              className={`button overview-toolbar-button ${filtersOpen ? "toolbar-selected" : ""}`}
              type="button"
              onClick={() => {
                setFiltersOpen((open) => !open);
                setGroupOpen(false);
                setColumnsOpen(false);
              }}
            >
              <Filter size={16} aria-hidden="true" />
              Filter
              {activeFilterCount > 0 ? <span className="toolbar-count">{activeFilterCount}</span> : null}
            </button>

            {filtersOpen ? (
              <div className="overview-popover filter-popover">
                <div className="filter-popover-header">
                  <strong>Basic filters</strong>
                  <button className="text-button" type="button" onClick={clearAllFilters} disabled={activeFilterCount === 0 && !query}>
                    Clear all
                  </button>
                </div>
                <div className="filter-popover-body">
                  <div className="filter-categories" aria-label="Filter categories">
                    {filterSections.map((section) => (
                      <button
                        key={section.key}
                        className={section.key === activeFilter ? "selected" : ""}
                        type="button"
                        onClick={() => {
                          setActiveFilter(section.key);
                          setOptionSearch("");
                        }}
                      >
                        <span>{section.label}</span>
                        {section.selectedCount > 0 ? <strong>{section.selectedCount}</strong> : null}
                      </button>
                    ))}
                  </div>
                  <div className="filter-options">
                    <label className="filter-option-search">
                      <Search size={16} aria-hidden="true" />
                      <input
                        value={optionSearch}
                        onChange={(event) => setOptionSearch(event.target.value)}
                        placeholder={`Search ${selectedSection.label.toLowerCase()}`}
                      />
                    </label>
                    <div className="filter-option-list">
                      {visibleOptions.length === 0 ? (
                        <span className="filter-empty">No matching options</span>
                      ) : (
                        visibleOptions.map((option) => (
                          <label className="check-row" key={option.value}>
                            <input
                              type="checkbox"
                              checked={isOptionSelected(selectedSection.key, option.value)}
                              onChange={() => toggleFilterOption(selectedSection.key, option.value)}
                            />
                            <span>{option.label}</span>
                            <small>{option.count}</small>
                          </label>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
          </div>

          <div className="overview-action-host">
            <button
              className={`button overview-toolbar-button ${groupOpen || groupBy !== "none" ? "toolbar-selected" : ""}`}
              type="button"
              onClick={() => {
                setGroupOpen((open) => !open);
                setFiltersOpen(false);
                setColumnsOpen(false);
              }}
            >
              <Layers size={16} aria-hidden="true" />
              Group: {selectedGroupLabel}
            </button>

            {groupOpen ? (
              <div className="overview-popover group-popover">
                {groupOptions.map((option) => (
                  <button
                    key={option.value}
                    className={option.value === groupBy ? "selected" : ""}
                    type="button"
                    onClick={() => {
                      setGroupBy(option.value);
                      setCollapsedGroups([]);
                      setGroupOpen(false);
                    }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <div className="overview-action-host">
            <button
              className={`button overview-toolbar-button ${columnsOpen ? "toolbar-selected" : ""}`}
              type="button"
              onClick={() => {
                setColumnsOpen((open) => !open);
                setFiltersOpen(false);
                setGroupOpen(false);
              }}
            >
              <Columns3 size={16} aria-hidden="true" />
              Columns
              <span className="toolbar-count">{visibleColumnIds.length}</span>
            </button>

            {columnsOpen ? (
              <div className="overview-popover columns-popover">
                <div className="filter-popover-header">
                  <strong>Columns</strong>
                  <button
                    className="text-button"
                    type="button"
                    onClick={() => {
                      setVisibleColumnIds(defaultColumnIds);
                      setColumnOrder(allColumnIds);
                      setColumnSearch("");
                      setDraggedColumnId(undefined);
                    }}
                  >
                    Reset
                  </button>
                </div>
                <div className="columns-popover-body">
                  <label className="filter-option-search">
                    <Search size={16} aria-hidden="true" />
                    <input
                      value={columnSearch}
                      onChange={(event) => setColumnSearch(event.target.value)}
                      placeholder="Search columns"
                    />
                  </label>
                  <div className="filter-option-list column-option-list">
                    {visibleColumnOptions.length === 0 ? (
                      <span className="filter-empty">No matching columns</span>
                    ) : (
                      visibleColumnOptions.map((column) => {
                        const checked = visibleColumnIds.includes(column.id);
                        const columnIndex = columnOrder.indexOf(column.id);
                        return (
                          <div
                            className={`column-row ${draggedColumnId === column.id ? "dragging" : ""}`}
                            key={column.id}
                            draggable
                            onDragStart={(event) => {
                              setDraggedColumnId(column.id);
                              event.dataTransfer.effectAllowed = "move";
                            }}
                            onDragOver={(event) => {
                              event.preventDefault();
                              event.dataTransfer.dropEffect = "move";
                            }}
                            onDrop={(event) => {
                              event.preventDefault();
                              if (draggedColumnId) moveColumn(draggedColumnId, column.id);
                              setDraggedColumnId(undefined);
                            }}
                            onDragEnd={() => setDraggedColumnId(undefined)}
                          >
                            <GripVertical className="column-drag-icon" size={15} aria-hidden="true" />
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={checked && visibleColumnIds.length === 1}
                              onChange={() => toggleColumn(column.id)}
                            />
                            <span>{column.label}</span>
                            <div className="column-move-actions">
                              <button
                                type="button"
                                onClick={() => moveColumnByOffset(column.id, -1)}
                                disabled={columnIndex <= 0}
                                aria-label={`Move ${column.label} left`}
                                title="Move left"
                              >
                                <ArrowUp size={14} aria-hidden="true" />
                              </button>
                              <button
                                type="button"
                                onClick={() => moveColumnByOffset(column.id, 1)}
                                disabled={columnIndex === -1 || columnIndex >= columnOrder.length - 1}
                                aria-label={`Move ${column.label} right`}
                                title="Move right"
                              >
                                <ArrowDown size={14} aria-hidden="true" />
                              </button>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                  <span className="columns-popover-footer">
                    {visibleColumnIds.length} of {columnDefinitions.length} columns visible
                  </span>
                </div>
              </div>
            ) : null}
          </div>

          <span className="overview-result-count">
            {filteredRows.length} of {rows.length} runs
          </span>
        </div>

        {filterChips.length > 0 || query ? (
          <div className="active-filter-row">
            {query ? (
              <button className="filter-chip" type="button" onClick={() => setQuery("")}>
                Search: {query}
                <X size={14} aria-hidden="true" />
              </button>
            ) : null}
            {filterChips.map((chip) => (
              <button className="filter-chip" key={chip.key} type="button" onClick={chip.onClear}>
                {chip.label}
                <X size={14} aria-hidden="true" />
              </button>
            ))}
            <button className="text-button" type="button" onClick={clearAllFilters}>
              Clear all
            </button>
          </div>
        ) : null}

        {groupBy === "none" ? (
          <DataTable
            data={filteredRows}
            columns={columns}
            emptyLabel="No runs match the current filters"
            showSearch={false}
            initialSorting={overviewInitialSorting}
          />
        ) : (
          <div className="overview-groups">
            {groupedRows.length === 0 ? (
              <div className="overview-group-empty">No runs match the current filters</div>
            ) : (
              groupedRows.map((group) => {
                const collapsed = collapsedGroups.includes(group.key);
                return (
                  <section className="overview-group" key={group.key}>
                    <button
                      className="overview-group-header"
                      type="button"
                      onClick={() => setCollapsedGroups((current) => toggleValue(current, group.key))}
                    >
                      {collapsed ? <ChevronRight size={16} aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />}
                      <strong>{group.label}</strong>
                      <span>{group.rows.length} runs</span>
                    </button>
                    {collapsed ? null : (
                      <DataTable
                        data={group.rows}
                        columns={columns}
                        emptyLabel="No runs in this group"
                        compact
                        showSearch={false}
                        initialSorting={overviewInitialSorting}
                      />
                    )}
                  </section>
                );
              })
            )}
          </div>
        )}
      </section>
    </div>
  );
}
