import {
  Activity,
  BarChart3,
  ChevronsLeft,
  ChevronsRight,
  ClipboardCheck,
  Database,
  FolderInput,
  GitCompare,
  LayoutDashboard,
  Loader2,
  Table2,
  type LucideIcon
} from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";
import type { AppView } from "./AppState";
import { useAppState } from "./AppState";

const navItems: Array<{
  id: AppView;
  label: string;
  icon: LucideIcon;
  needsPackage?: boolean;
}> = [
  { id: "import", label: "Import", icon: FolderInput },
  { id: "library", label: "Library", icon: Database },
  { id: "coverage", label: "Coverage", icon: ClipboardCheck, needsPackage: true },
  { id: "overview", label: "Overview", icon: Table2, needsPackage: true },
  { id: "explorer", label: "Metrics", icon: BarChart3, needsPackage: true },
  { id: "regression", label: "Regression", icon: Activity, needsPackage: true },
  { id: "comparisons", label: "Compare", icon: GitCompare, needsPackage: true }
];

export function Shell({ children }: { children: ReactNode }) {
  const { activePackage, packages, view, setView, isBusy, busyLabel } = useAppState();
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className={collapsed ? "app-shell sidebar-collapsed" : "app-shell"}>
      <aside className="sidebar">
        <div className="brand">
          <LayoutDashboard size={22} aria-hidden="true" />
          <div>
            <strong>Perfexa</strong>
            <span>Performance runs</span>
          </div>
          <button
            type="button"
            className="sidebar-toggle"
            onClick={() => setCollapsed((value) => !value)}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? <ChevronsRight size={16} /> : <ChevronsLeft size={16} />}
          </button>
        </div>
        <nav className="nav-list" aria-label="Main navigation">
          {navItems.map((item) => {
            const Icon = item.icon;
            const disabled = item.needsPackage && !activePackage;
            return (
              <button
                key={item.id}
                type="button"
                className={view === item.id ? "nav-item nav-active" : "nav-item"}
                onClick={() => setView(item.id)}
                disabled={disabled}
                title={disabled ? "Import a package first" : item.label}
              >
                <Icon size={18} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
        <div className="sidebar-footer">
          <span>{packages.length} package{packages.length === 1 ? "" : "s"}</span>
          <strong>{activePackage?.name ?? "No package selected"}</strong>
          <span className="sidebar-version">Perfexa v{__APP_VERSION__}</span>
        </div>
      </aside>
      <main className="main-view">
        {isBusy ? (
          <div className="global-loading" role="status" aria-live="polite" title={busyLabel}>
            <Loader2 size={20} />
            <span className="sr-only">{busyLabel}</span>
          </div>
        ) : null}
        <div className={isBusy ? "page-transition page-transition-busy" : "page-transition"}>
          {children}
        </div>
      </main>
    </div>
  );
}
