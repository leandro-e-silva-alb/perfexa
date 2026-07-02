import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { ImportedPackage, NotesDocument } from "../domain/types";
import { createStorage, type PerfexaStorage } from "../storage/database";

export type AppView = "import" | "library" | "overview" | "explorer" | "regression" | "comparisons";

interface AppStateValue {
  storageReady: boolean;
  packages: ImportedPackage[];
  activePackage?: ImportedPackage;
  activePackageId?: string;
  view: AppView;
  isBusy: boolean;
  busyLabel: string;
  setView(view: AppView): void;
  selectPackage(id: string): void;
  saveImportedPackage(pkg: ImportedPackage): Promise<void>;
  updateActivePackageNotes(notes: NotesDocument): Promise<void>;
  reloadPackages(): Promise<void>;
}

const AppStateContext = createContext<AppStateValue | undefined>(undefined);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [storage, setStorage] = useState<PerfexaStorage>();
  const [packages, setPackages] = useState<ImportedPackage[]>([]);
  const [activePackageId, setActivePackageId] = useState<string>();
  const [view, setCurrentView] = useState<AppView>("import");
  const [storageReady, setStorageReady] = useState(false);
  const [busyLabel, setBusyLabel] = useState("Starting");
  const [navigationBusy, setNavigationBusy] = useState(false);
  const [operationBusy, setOperationBusy] = useState(true);

  useEffect(() => {
    let mounted = true;
    createStorage()
      .then(async (nextStorage) => {
        if (!mounted) return;
        setStorage(nextStorage);
        const loaded = await nextStorage.listPackages();
        if (!mounted) return;
        setPackages(loaded);
        setActivePackageId((current) => current ?? loaded[0]?.id);
        if (loaded.length > 0) setCurrentView("library");
      })
      .finally(() => {
        if (mounted) {
          setStorageReady(true);
          setOperationBusy(false);
        }
      });

    return () => {
      mounted = false;
    };
  }, []);

  const activePackage = useMemo(
    () => packages.find((pkg) => pkg.id === activePackageId),
    [activePackageId, packages]
  );

  async function reloadPackages() {
    if (!storage) return;
    setOperationBusy(true);
    setBusyLabel("Loading packages");
    try {
      const loaded = await storage.listPackages();
      setPackages(loaded);
      setActivePackageId((current) => current ?? loaded[0]?.id);
    } finally {
      setOperationBusy(false);
    }
  }

  async function saveImportedPackage(pkg: ImportedPackage) {
    if (!storage) return;
    setOperationBusy(true);
    setBusyLabel("Saving import");
    try {
      await storage.savePackage(pkg);
      const loaded = await storage.listPackages();
      setPackages(loaded);
      setActivePackageId(pkg.id);
      setCurrentView("overview");
    } finally {
      setOperationBusy(false);
    }
  }

  async function updateActivePackageNotes(notes: NotesDocument) {
    if (!storage || !activePackage) return;
    setOperationBusy(true);
    setBusyLabel("Saving note");
    try {
      await storage.updatePackageNotes(activePackage.id, notes);
      setPackages((current) =>
        current.map((pkg) => (pkg.id === activePackage.id ? { ...pkg, notes } : pkg))
      );
    } finally {
      setOperationBusy(false);
    }
  }

  function setView(view: AppView) {
    setBusyLabel("Loading view");
    setNavigationBusy(true);
    setCurrentView(view);
    window.setTimeout(() => setNavigationBusy(false), 220);
  }

  function selectPackage(id: string) {
    setBusyLabel("Opening package");
    setNavigationBusy(true);
    setActivePackageId(id);
    setCurrentView("overview");
    window.setTimeout(() => setNavigationBusy(false), 220);
  }

  const isBusy = operationBusy || navigationBusy || !storageReady;

  const value: AppStateValue = {
    storageReady,
    packages,
    activePackage,
    activePackageId,
    view,
    isBusy,
    busyLabel,
    setView,
    selectPackage,
    saveImportedPackage,
    updateActivePackageNotes,
    reloadPackages
  };

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export function useAppState(): AppStateValue {
  const value = useContext(AppStateContext);
  if (!value) throw new Error("useAppState must be used inside AppStateProvider");
  return value;
}
