import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { ImportedPackage, NotesDocument } from "../domain/types";
import { createStorage, type PerfexaStorage } from "../storage/database";

export type AppView =
  | "package-import"
  | "package-library"
  | "scenario-board"
  | "run-explorer"
  | "test-metrics"
  | "sizing-models"
  | "test-compare";

interface AppStateValue {
  storageReady: boolean;
  packages: ImportedPackage[];
  activePackage?: ImportedPackage;
  activePackageId?: string;
  view: AppView;
  isBusy: boolean;
  busyLabel: string;
  comparisonTestKeys: string[];
  setView(view: AppView): void;
  setComparisonTestKeys(testKeys: string[]): void;
  selectPackage(id: string): void;
  saveImportedPackage(pkg: ImportedPackage): Promise<void>;
  deleteImportedPackage(id: string): Promise<void>;
  updateActivePackageNotes(notes: NotesDocument): Promise<void>;
  reloadPackages(): Promise<void>;
}

const AppStateContext = createContext<AppStateValue | undefined>(undefined);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [storage, setStorage] = useState<PerfexaStorage>();
  const [packages, setPackages] = useState<ImportedPackage[]>([]);
  const [activePackageId, setActivePackageId] = useState<string>();
  const [view, setCurrentView] = useState<AppView>("package-import");
  const [storageReady, setStorageReady] = useState(false);
  const [busyLabel, setBusyLabel] = useState("Starting");
  const [navigationBusy, setNavigationBusy] = useState(false);
  const [operationBusy, setOperationBusy] = useState(true);
  const [comparisonTestKeys, setComparisonTestKeysState] = useState<string[]>([]);

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
        if (loaded.length > 0) setCurrentView("package-library");
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
    if (!storage) throw new Error("Storage is not ready yet.");
    setOperationBusy(true);
    setBusyLabel("Saving import");
    try {
      await storage.savePackage(pkg);
      const loaded = await storage.listPackages();
      if (!loaded.some((item) => item.id === pkg.id)) {
        throw new Error("The package was saved, but could not be loaded back from storage.");
      }
      setPackages(loaded);
      setActivePackageId(pkg.id);
      setComparisonTestKeysState([]);
      setCurrentView("run-explorer");
    } catch (error) {
      console.error("Unable to save imported package.", error);
      throw error;
    } finally {
      setOperationBusy(false);
    }
  }

  async function deleteImportedPackage(id: string) {
    if (!storage) throw new Error("Storage is not ready yet.");
    setOperationBusy(true);
    setBusyLabel("Deleting package");
    try {
      await storage.deletePackage(id);
      const loaded = await storage.listPackages();
      setPackages(loaded);
      setActivePackageId((current) => (current === id ? loaded[0]?.id : current));
      if (activePackageId === id) {
        setComparisonTestKeysState([]);
      }
    } catch (error) {
      console.error("Unable to delete imported package.", error);
      throw error;
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

  function setComparisonTestKeys(testKeys: string[]) {
    setComparisonTestKeysState([...new Set(testKeys)]);
  }

  function selectPackage(id: string) {
    setBusyLabel("Opening package");
    setNavigationBusy(true);
    setActivePackageId(id);
    setComparisonTestKeysState([]);
    setCurrentView("run-explorer");
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
    comparisonTestKeys,
    setView,
    setComparisonTestKeys,
    selectPackage,
    saveImportedPackage,
    deleteImportedPackage,
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
