import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { ImportedPackage, NotesDocument } from "../domain/types";
import { createStorage, type PerfexaStorage } from "../storage/database";
import {
  packageIdFromPathname,
  routeForView,
  testKeysFromSearch,
  viewFromPathname,
  withTestKeys,
  type AppView
} from "./routes";

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
  const location = useLocation();
  const navigate = useNavigate();
  const [storage, setStorage] = useState<PerfexaStorage>();
  const [packages, setPackages] = useState<ImportedPackage[]>([]);
  const [selectedPackageId, setSelectedPackageId] = useState<string>();
  const [storageReady, setStorageReady] = useState(false);
  const [busyLabel, setBusyLabel] = useState("Starting");
  const [navigationBusy, setNavigationBusy] = useState(false);
  const [operationBusy, setOperationBusy] = useState(true);
  const [pendingComparisonTestKeys, setPendingComparisonTestKeys] = useState<string[]>([]);
  const comparisonTestKeysRef = useRef<string[]>([]);
  const initialRoutePackageIdRef = useRef<string | undefined>(packageIdFromPathname(location.pathname));

  const routePackageId = useMemo(() => packageIdFromPathname(location.pathname), [location.pathname]);
  const activePackageId = routePackageId ?? selectedPackageId;
  const view = viewFromPathname(location.pathname);
  const comparisonTestKeys = view === "test-compare" ? testKeysFromSearch(location.search) : pendingComparisonTestKeys;

  useEffect(() => {
    let mounted = true;
    createStorage()
      .then(async (nextStorage) => {
        if (!mounted) return;
        setStorage(nextStorage);
        const loaded = await nextStorage.listPackages();
        if (!mounted) return;
        setPackages(loaded);
        setSelectedPackageId((current) => current ?? initialRoutePackageIdRef.current ?? loaded[0]?.id);
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

  useEffect(() => {
    if (routePackageId) {
      setSelectedPackageId(routePackageId);
    }
  }, [routePackageId]);

  useEffect(() => {
    if (view === "test-compare") {
      comparisonTestKeysRef.current = comparisonTestKeys;
    }
  }, [comparisonTestKeys, view]);

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
      setSelectedPackageId((current) => current ?? loaded[0]?.id);
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
      setSelectedPackageId(pkg.id);
      setComparisonTestKeys([]);
      navigate(routeForView("run-explorer", pkg.id));
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
      const nextPackageId = loaded[0]?.id;
      setSelectedPackageId((current) => (current === id ? nextPackageId : current));
      if (activePackageId === id) {
        setComparisonTestKeys([]);
        navigate(nextPackageId ? routeForView("run-explorer", nextPackageId) : routeForView("package-import"));
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
    const nextRoute = routeForView(view, activePackageId);
    const nextUrl =
      view === "test-compare" ? withTestKeys(nextRoute, comparisonTestKeysRef.current) : nextRoute;
    navigate(nextUrl);
    window.setTimeout(() => setNavigationBusy(false), 220);
  }

  function setComparisonTestKeys(testKeys: string[]) {
    const nextKeys = [...new Set(testKeys)];
    comparisonTestKeysRef.current = nextKeys;
    setPendingComparisonTestKeys(nextKeys);

    if (view === "test-compare") {
      navigate(withTestKeys(location.pathname, nextKeys), { replace: true });
    }
  }

  function selectPackage(id: string) {
    setBusyLabel("Opening package");
    setNavigationBusy(true);
    setSelectedPackageId(id);
    setComparisonTestKeys([]);
    navigate(routeForView("run-explorer", id));
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
