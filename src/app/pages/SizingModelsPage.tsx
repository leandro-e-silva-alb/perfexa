import type { ColumnDef, SortingState } from "@tanstack/react-table";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Columns3,
  Filter,
  GitCompare,
  GripVertical,
  Layers,
  Search,
  X
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DataTable } from "../../components/DataTable";
import { HelpModal } from "../../components/HelpModal";
import { StatusPill } from "../../components/StatusPill";
import { buildCpuSizingModelRows, type CpuSizingModelRow } from "../../domain/sizingModels";
import { useAppState } from "../AppState";

type FilterSectionKey = "scenario" | "test" | "exagonVersion";
type GroupBy = "none" | "test" | "scenario" | "exagonVersion";
type SizingModelsColumnId =
  | "scenario"
  | "exagonVersion"
  | "sequenceId"
  | "idle"
  | "marginalCpu"
  | "transientOverhead"
  | "halfSaturationK"
  | "rSquared"
  | "rmse"
  | "points";

interface SizingModelsColumn {
  id: SizingModelsColumnId;
  label: string;
  column: ColumnDef<CpuSizingModelRow>;
}

interface SizingModelsFilters {
  scenarioIds: string[];
  testKeys: string[];
  exagonVersions: string[];
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

const emptyFilters: SizingModelsFilters = {
  scenarioIds: [],
  testKeys: [],
  exagonVersions: []
};

const groupOptions: Array<{ value: GroupBy; label: string }> = [
  { value: "none", label: "No grouping" },
  { value: "test", label: "Test" },
  { value: "scenario", label: "Scenario" },
  { value: "exagonVersion", label: "Exagon version" }
];

const allColumnIds: SizingModelsColumnId[] = [
  "scenario",
  "exagonVersion",
  "sequenceId",
  "idle",
  "marginalCpu",
  "transientOverhead",
  "halfSaturationK",
  "rSquared",
  "rmse",
  "points"
];

const defaultColumnIds: SizingModelsColumnId[] = [
  "scenario",
  "exagonVersion",
  "sequenceId",
  "idle",
  "marginalCpu",
  "transientOverhead",
  "halfSaturationK",
  "rSquared",
  "rmse",
  "points"
];

function toggleValue(values: string[], value: string): string[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

function selectionActionTarget(): Element {
  return document.querySelector(".content-column") ?? document.querySelector(".main-view") ?? document.body;
}

function optionsFromRows(
  rows: CpuSizingModelRow[],
  getValue: (row: CpuSizingModelRow) => string,
  getLabel: (row: CpuSizingModelRow) => string
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

  return [...options.values()].sort((left, right) =>
    left.label.localeCompare(right.label, undefined, { numeric: true })
  );
}

function formatFixed(value: number | null, digits: number): string {
  if (value === null || Number.isNaN(value)) {
    return "-";
  }

  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  }).format(value);
}

function nullableNumberSort<TData>(
  left: { original: TData },
  right: { original: TData },
  columnId: string
): number {
  const leftValue = (left.original as Record<string, number | null>)[columnId];
  const rightValue = (right.original as Record<string, number | null>)[columnId];

  if (leftValue === null && rightValue === null) {
    return 0;
  }

  if (leftValue === null) {
    return 1;
  }

  if (rightValue === null) {
    return -1;
  }

  return leftValue - rightValue;
}

export function SizingModelsPage() {
  const { activePackage, setComparisonTestKeys, setView } = useAppState();
  const [query, setQuery] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [groupOpen, setGroupOpen] = useState(false);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [activeFilter, setActiveFilter] = useState<FilterSectionKey>("scenario");
  const [optionSearch, setOptionSearch] = useState("");
  const [columnSearch, setColumnSearch] = useState("");
  const [groupBy, setGroupBy] = useState<GroupBy>("none");
  const [collapsedGroups, setCollapsedGroups] = useState<string[]>([]);
  const [columnOrder, setColumnOrder] = useState<SizingModelsColumnId[]>(allColumnIds);
  const [visibleColumnIds, setVisibleColumnIds] = useState<SizingModelsColumnId[]>(defaultColumnIds);
  const [draggedColumnId, setDraggedColumnId] = useState<SizingModelsColumnId>();
  const [selectedTestKeys, setSelectedTestKeys] = useState<string[]>([]);
  const [helpOpen, setHelpOpen] = useState(false);
  const [filters, setFilters] = useState<SizingModelsFilters>(emptyFilters);
  const filterPopoverHostRef = useRef<HTMLDivElement>(null);
  const groupPopoverHostRef = useRef<HTMLDivElement>(null);
  const columnsPopoverHostRef = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => (activePackage ? buildCpuSizingModelRows(activePackage) : []), [activePackage]);

  useEffect(() => {
    setQuery("");
    setFilters(emptyFilters);
    setFiltersOpen(false);
    setGroupOpen(false);
    setColumnsOpen(false);
    setActiveFilter("scenario");
    setOptionSearch("");
    setColumnSearch("");
    setGroupBy("none");
    setCollapsedGroups([]);
    setSelectedTestKeys([]);
  }, [activePackage?.id]);

  useEffect(() => {
    if (!filtersOpen && !groupOpen && !columnsOpen) return;

    function closeOpenPopoversOnOutsidePointerDown(event: PointerEvent): void {
      const target = event.target;
      if (!(target instanceof Node)) return;

      if (filtersOpen && !filterPopoverHostRef.current?.contains(target)) {
        setFiltersOpen(false);
      }
      if (groupOpen && !groupPopoverHostRef.current?.contains(target)) {
        setGroupOpen(false);
      }
      if (columnsOpen && !columnsPopoverHostRef.current?.contains(target)) {
        setColumnsOpen(false);
      }
    }

    document.addEventListener("pointerdown", closeOpenPopoversOnOutsidePointerDown);
    return () => document.removeEventListener("pointerdown", closeOpenPopoversOnOutsidePointerDown);
  }, [columnsOpen, filtersOpen, groupOpen]);

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

  const fittedRows = rows.filter((row) => row.rSquared !== null);
  const selectedSet = new Set(selectedTestKeys);
  const activeFilterCount = filters.scenarioIds.length + filters.testKeys.length + filters.exagonVersions.length;

  const filterSections: FilterSection[] = [
    {
      key: "scenario",
      label: "Scenario",
      selectedCount: filters.scenarioIds.length,
      options: optionsFromRows(rows, (row) => row.scenarioId, (row) => row.scenario)
    },
    {
      key: "test",
      label: "Test",
      selectedCount: filters.testKeys.length,
      options: optionsFromRows(rows, (row) => row.testKey, (row) => row.testKey)
    },
    {
      key: "exagonVersion",
      label: "Exagon version",
      selectedCount: filters.exagonVersions.length,
      options: optionsFromRows(rows, (row) => row.exagonVersion, (row) => row.exagonVersion)
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
    return filters.exagonVersions.includes(value);
  }

  function toggleFilterOption(sectionKey: FilterSectionKey, value: string): void {
    setSelectedTestKeys([]);
    setFilters((current) => {
      if (sectionKey === "scenario") return { ...current, scenarioIds: toggleValue(current.scenarioIds, value) };
      if (sectionKey === "test") return { ...current, testKeys: toggleValue(current.testKeys, value) };
      return { ...current, exagonVersions: toggleValue(current.exagonVersions, value) };
    });
  }

  function clearAllFilters(): void {
    setSelectedTestKeys([]);
    setFilters(emptyFilters);
    setQuery("");
    setOptionSearch("");
  }

  function toggleRow(testKey: string) {
    setSelectedTestKeys((current) =>
      current.includes(testKey) ? current.filter((key) => key !== testKey) : [...current, testKey]
    );
  }

  function toggleAllRows() {
    setSelectedTestKeys((current) => {
      const filteredKeys = filteredRows.map((row) => row.testKey);
      const allFilteredSelected = filteredKeys.length > 0 && filteredKeys.every((key) => current.includes(key));
      return allFilteredSelected ? [] : filteredKeys;
    });
  }

  function compareSelectedRows() {
    setComparisonTestKeys(selectedTestKeys);
    setView("test-compare");
  }

  function selectFilteredRows() {
    setSelectedTestKeys(filteredRows.map((row) => row.testKey));
  }

  function toggleColumn(columnId: SizingModelsColumnId): void {
    setVisibleColumnIds((current) => {
      if (current.includes(columnId)) {
        return current.length === 1 ? current : current.filter((id) => id !== columnId);
      }

      return [...current, columnId];
    });
  }

  function moveColumn(columnId: SizingModelsColumnId, targetColumnId: SizingModelsColumnId): void {
    if (columnId === targetColumnId) return;
    setColumnOrder((current) => {
      const next = current.filter((id) => id !== columnId);
      const targetIndex = next.indexOf(targetColumnId);
      if (targetIndex === -1) return current;
      next.splice(targetIndex, 0, columnId);
      return next;
    });
  }

  function moveColumnByOffset(columnId: SizingModelsColumnId, offset: number): void {
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
    if (filters.scenarioIds.length > 0 && !filters.scenarioIds.includes(row.scenarioId)) return false;
    if (filters.testKeys.length > 0 && !filters.testKeys.includes(row.testKey)) return false;
    if (filters.exagonVersions.length > 0 && !filters.exagonVersions.includes(row.exagonVersion)) return false;

    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return true;

    return [
      row.testKey,
      row.scenarioId,
      row.scenario,
      row.configId,
      row.exagonVersion,
      String(row.sequenceId),
      formatFixed(row.idle, 2),
      formatFixed(row.marginalCpu, 4),
      formatFixed(row.transientOverhead, 2),
      formatFixed(row.halfSaturationK, 2),
      formatFixed(row.rSquared, 4),
      formatFixed(row.rmse, 2),
      `${row.fittedPoints}/${row.totalPoints}`
    ]
      .join(" ")
      .toLowerCase()
      .includes(normalizedQuery);
  });

  const groupedRows = (() => {
    if (groupBy === "none") return [];

    const groups = new Map<string, { key: string; label: string; rows: CpuSizingModelRow[] }>();
    for (const row of filteredRows) {
      const group =
        groupBy === "test"
          ? { key: row.testKey, label: row.testKey }
          : groupBy === "scenario"
            ? { key: row.scenarioId, label: row.scenario }
            : { key: row.exagonVersion, label: row.exagonVersion };
      const existing = groups.get(group.key);

      if (existing) {
        existing.rows.push(row);
      } else {
        groups.set(group.key, { ...group, rows: [row] });
      }
    }

    return [...groups.values()].sort((left, right) =>
      left.label.localeCompare(right.label, undefined, { numeric: true })
    );
  })();

  const filterChips = [
    filters.scenarioIds.length
      ? {
          key: "scenario",
          label: `Scenario: ${chipLabel("scenario", filters.scenarioIds)}`,
          onClear: () => {
            setSelectedTestKeys([]);
            setFilters((current) => ({ ...current, scenarioIds: [] }));
          }
        }
      : undefined,
    filters.testKeys.length
      ? {
          key: "test",
          label: `Test: ${chipLabel("test", filters.testKeys)}`,
          onClear: () => {
            setSelectedTestKeys([]);
            setFilters((current) => ({ ...current, testKeys: [] }));
          }
        }
      : undefined,
    filters.exagonVersions.length
      ? {
          key: "exagonVersion",
          label: `Exagon version: ${chipLabel("exagonVersion", filters.exagonVersions)}`,
          onClear: () => {
            setSelectedTestKeys([]);
            setFilters((current) => ({ ...current, exagonVersions: [] }));
          }
        }
      : undefined
  ].filter(Boolean) as Array<{ key: string; label: string; onClear: () => void }>;

  const selectedGroupLabel = groupOptions.find((option) => option.value === groupBy)?.label ?? "No grouping";
  const sizingModelsInitialSorting: SortingState = [{ id: "scenario", desc: false }];
  const selectionColumn: ColumnDef<CpuSizingModelRow> = {
    id: "selection",
    header: () => (
      <label className="sizing-models-select-cell">
        <input
          aria-label="Select all visible sizing model rows"
          checked={filteredRows.length > 0 && filteredRows.every((row) => selectedSet.has(row.testKey))}
          type="checkbox"
          onChange={toggleAllRows}
        />
      </label>
    ),
    cell: ({ row }) => (
      <label className="sizing-models-select-cell">
        <input
          aria-label={`Select ${row.original.testKey}`}
          checked={selectedSet.has(row.original.testKey)}
          type="checkbox"
          onChange={() => toggleRow(row.original.testKey)}
        />
      </label>
    ),
    enableSorting: false,
    meta: { hideSortMarker: true }
  };
  const columnDefinitions: SizingModelsColumn[] = [
    { id: "scenario", label: "Scenario", column: { id: "scenario", header: "Scenario", accessorKey: "scenario" } },
    {
      id: "exagonVersion",
      label: "Exagon version",
      column: { id: "exagonVersion", header: "Exagon version", accessorKey: "exagonVersion" }
    },
    { id: "sequenceId", label: "SN", column: { id: "sequenceId", header: "SN", accessorKey: "sequenceId" } },
    {
      id: "idle",
      label: "Base CPU (idle)",
      column: {
        id: "idle",
        header: "Base CPU (idle)",
        accessorKey: "idle",
        sortingFn: nullableNumberSort,
        cell: ({ row }) => formatFixed(row.original.idle, 2)
      }
    },
    {
      id: "marginalCpu",
      label: "Incremental CPU (L)",
      column: {
        id: "marginalCpu",
        header: "Incremental CPU (L)",
        accessorKey: "marginalCpu",
        sortingFn: nullableNumberSort,
        cell: ({ row }) => formatFixed(row.original.marginalCpu, 4)
      }
    },
    {
      id: "transientOverhead",
      label: "Transient CPU overhead",
      column: {
        id: "transientOverhead",
        header: "Transient CPU overhead (extra)",
        accessorKey: "transientOverhead",
        sortingFn: nullableNumberSort,
        cell: ({ row }) => formatFixed(row.original.transientOverhead, 2)
      }
    },
    {
      id: "halfSaturationK",
      label: "Overhead half-saturation const.",
      column: {
        id: "halfSaturationK",
        header: "Overhead half-saturation const. (k)",
        accessorKey: "halfSaturationK",
        sortingFn: nullableNumberSort,
        cell: ({ row }) => formatFixed(row.original.halfSaturationK, 2)
      }
    },
    {
      id: "rSquared",
      label: "R2",
      column: {
        id: "rSquared",
        header: "R2",
        accessorKey: "rSquared",
        sortingFn: nullableNumberSort,
        cell: ({ row }) => (row.original.rSquared === null ? "-" : formatFixed(row.original.rSquared, 4))
      }
    },
    {
      id: "rmse",
      label: "RMSE",
      column: {
        id: "rmse",
        header: "RMSE",
        accessorKey: "rmse",
        sortingFn: nullableNumberSort,
        cell: ({ row }) => formatFixed(row.original.rmse, 2)
      }
    },
    {
      id: "points",
      label: "Points Fitted/Total",
      column: {
        id: "points",
        header: "Points Fitted/Total",
        cell: ({ row }) => `${row.original.fittedPoints}/${row.original.totalPoints}`
      }
    }
  ];
  const columnDefinitionMap = new Map(columnDefinitions.map((column) => [column.id, column]));
  const orderedColumnDefinitions = columnOrder
    .map((id) => columnDefinitionMap.get(id))
    .filter(Boolean) as SizingModelsColumn[];
  const columns = [
    selectionColumn,
    ...orderedColumnDefinitions
      .filter((column) => visibleColumnIds.includes(column.id))
      .map((column) => column.column)
  ];
  const visibleColumnOptions = orderedColumnDefinitions.filter((column) =>
    column.label.toLowerCase().includes(columnSearch.trim().toLowerCase())
  );
  return (
    <div className="page-stack page-stack-wide">
      <header className="page-header">
        <div>
          <p className="eyebrow">Sizing Models</p>
          <h1>CPU over TPS</h1>
          <span className="header-meta">{activePackage.name}</span>
        </div>
        <div className="header-actions">
          <button
            className="button"
            type="button"
            onClick={() => setHelpOpen((open) => !open)}
            aria-expanded={helpOpen}
            aria-controls="sizing-models-help"
            title="Show sizing model help"
          >
            <CircleHelp size={16} aria-hidden="true" />
            Help
          </button>
          <StatusPill tone={fittedRows.length > 0 ? "ok" : "warn"}>
            {fittedRows.length} of {rows.length} fitted
          </StatusPill>
        </div>
      </header>

      <section className="panel run-explorer-results-panel">
        <div className="run-explorer-workbar">
          <label className="run-explorer-search" aria-label="Search sizing model rows">
            <Search size={16} aria-hidden="true" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search sizing model rows"
            />
          </label>

          <div className="run-explorer-action-host" ref={filterPopoverHostRef}>
            <button
              className={`button run-explorer-toolbar-button ${filtersOpen ? "toolbar-selected" : ""}`}
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
              <div className="run-explorer-popover filter-popover">
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

          <div className="run-explorer-action-host" ref={groupPopoverHostRef}>
            <button
              className={`button run-explorer-toolbar-button ${groupOpen || groupBy !== "none" ? "toolbar-selected" : ""}`}
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
              <div className="run-explorer-popover group-popover">
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

          <div className="run-explorer-action-host" ref={columnsPopoverHostRef}>
            <button
              className={`button run-explorer-toolbar-button ${columnsOpen ? "toolbar-selected" : ""}`}
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
              <div className="run-explorer-popover columns-popover">
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

          <span className="run-explorer-result-count">
            {filteredRows.length} of {rows.length} models
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
            emptyLabel="No sizing model rows"
            initialSorting={sizingModelsInitialSorting}
            showSearch={false}
          />
        ) : (
          <div className="run-explorer-groups">
            {groupedRows.length === 0 ? (
              <div className="run-explorer-group-empty">No sizing model rows</div>
            ) : (
              groupedRows.map((group) => {
                const collapsed = collapsedGroups.includes(group.key);
                return (
                  <section className="run-explorer-group" key={group.key}>
                    <button
                      className="run-explorer-group-header"
                      type="button"
                      onClick={() => setCollapsedGroups((current) => toggleValue(current, group.key))}
                    >
                      {collapsed ? (
                        <ChevronRight size={16} aria-hidden="true" />
                      ) : (
                        <ChevronDown size={16} aria-hidden="true" />
                      )}
                      <strong>{group.label}</strong>
                      <span>{group.rows.length} models</span>
                    </button>
                    {collapsed ? null : (
                      <DataTable
                        data={group.rows}
                        columns={columns}
                        emptyLabel="No sizing model rows in this group"
                        compact
                        showSearch={false}
                        initialSorting={sizingModelsInitialSorting}
                      />
                    )}
                  </section>
                );
              })
            )}
          </div>
        )}
      </section>
      {selectedTestKeys.length > 0
        ? createPortal(
            <div className="selection-action-bar" role="region" aria-label="Selected sizing models actions">
              <strong>{selectedTestKeys.length}</strong>
              <span aria-live="polite">selected</span>
              <div className="selection-action-spacer" />
              <button className="button" type="button" onClick={selectFilteredRows} disabled={filteredRows.length === 0}>
                Select all
              </button>
              <button className="button button-primary" type="button" onClick={compareSelectedRows}>
                <GitCompare size={16} aria-hidden="true" />
                Compare tests
              </button>
              <div className="selection-action-spacer" />
              <button
                className="icon-button"
                type="button"
                onClick={() => setSelectedTestKeys([])}
                aria-label="Clear selected"
                title="Clear selected"
              >
                <X size={17} aria-hidden="true" />
              </button>
            </div>,
            selectionActionTarget()
          )
        : null}
      <HelpModal
        open={helpOpen}
        title="Sizing model help"
        id="sizing-models-help"
        className="sizing-models-help-modal"
        contentClassName="sizing-models-help-content"
        closeLabel="Close sizing model help"
        onClose={() => setHelpOpen(false)}
      >
        <img src="/sizing-models-cpu-model.png" alt="Decomposicao do modelo CPU por TPS" />
      </HelpModal>
    </div>
  );
}
