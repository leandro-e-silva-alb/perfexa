import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState
} from "@tanstack/react-table";
import { Search } from "lucide-react";
import { useState } from "react";

interface DataTableProps<TData> {
  data: TData[];
  columns: ColumnDef<TData>[];
  searchPlaceholder?: string;
  emptyLabel?: string;
  compact?: boolean;
  showSearch?: boolean;
  initialSorting?: SortingState;
}

export function DataTable<TData>({
  data,
  columns,
  searchPlaceholder = "Search",
  emptyLabel = "No rows",
  compact = false,
  showSearch = true,
  initialSorting = []
}: DataTableProps<TData>) {
  const [sorting, setSorting] = useState<SortingState>(initialSorting);
  const [globalFilter, setGlobalFilter] = useState("");

  const table = useReactTable({
    data,
    columns,
    state: {
      sorting,
      globalFilter
    },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel()
  });

  return (
    <div className="table-block">
      {showSearch ? (
        <label className="search-box">
          <Search size={16} aria-hidden="true" />
          <input
            value={globalFilter}
            onChange={(event) => setGlobalFilter(event.target.value)}
            placeholder={searchPlaceholder}
          />
        </label>
      ) : null}
      <div className={`data-table-wrap ${compact ? "table-compact" : ""}`}>
        <table className="data-table">
          <thead>
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <th key={header.id}>
                    {header.isPlaceholder ? null : header.column.getCanSort() ? (
                      <button
                        className="th-button"
                        type="button"
                        onClick={header.column.getToggleSortingHandler()}
                      >
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        <span className="sort-mark">
                          {header.column.getIsSorted() === "asc"
                            ? "A-Z"
                            : header.column.getIsSorted() === "desc"
                              ? "Z-A"
                            : ""}
                        </span>
                      </button>
                    ) : (
                      <span className="th-button th-static">
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        <span className="sort-mark" />
                      </span>
                    )}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.length === 0 ? (
              <tr>
                <td className="empty-cell" colSpan={columns.length}>
                  {emptyLabel}
                </td>
              </tr>
            ) : (
              table.getRowModel().rows.map((row) => (
                <tr key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
