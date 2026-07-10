import JSZip, { type JSZipObject } from "jszip";
import type { ImportFileSource } from "../domain/types";

const requiredTextFiles = [
  "manifest.yaml",
  "runs.csv",
  "tests.csv",
  "configs.csv",
  "scenarios.csv",
  "measurements.csv",
  "metrics.yaml",
  "topology.yaml",
  "saturation.yaml",
  "notes.yaml"
];

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

function joinPath(root: string, relativePath: string): string {
  const separator = root.includes("\\") ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${separator}${relativePath.replace(/\//g, separator)}`;
}

function fileNameFromPath(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function packageNameFromZipName(name: string): string {
  return fileNameFromPath(name).replace(/\.zip$/i, "") || "perf-import";
}

function normalizeZipPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "").replace(/^\.\//, "");
}

function normalizeImportPath(path: string): string {
  return normalizeZipPath(path).replace(/\/+$/, "");
}

function isRootPath(path: string): boolean {
  return normalizeImportPath(path).length > 0 && !normalizeImportPath(path).includes("/");
}

function isSystemZipEntry(path: string): boolean {
  return path === "__MACOSX" || path.startsWith("__MACOSX/") || path.endsWith("/.DS_Store");
}

function zipEntries(zip: JSZip): Array<{ path: string; entry: JSZipObject }> {
  return Object.values(zip.files)
    .map((entry) => ({ path: normalizeZipPath(entry.name), entry }))
    .filter(({ path }) => path.length > 0 && !isSystemZipEntry(path));
}

function findZipRootPrefix(paths: string[]): string {
  const fileSet = new Set(paths);
  if (requiredTextFiles.every((file) => fileSet.has(file))) return "";

  const manifestPrefixes = paths
    .filter((path) => path.endsWith("/manifest.yaml"))
    .map((path) => path.slice(0, -"manifest.yaml".length))
    .sort((a, b) => a.length - b.length);

  return manifestPrefixes.find((prefix) => requiredTextFiles.every((file) => fileSet.has(`${prefix}${file}`))) ?? "";
}

function findZipRootPrefixForPath(paths: string[], packagePath: string): string | undefined {
  const normalizedPath = normalizeImportPath(packagePath);
  if (!normalizedPath) return findZipRootPrefix(paths);

  const fileSet = new Set(paths);
  const suffix = `${normalizedPath}/`;
  const manifestPrefixes = paths
    .filter((path) => path.endsWith(`${suffix}manifest.yaml`))
    .map((path) => path.slice(0, -"manifest.yaml".length))
    .sort((a, b) => a.length - b.length);

  return manifestPrefixes.find((prefix) => requiredTextFiles.every((file) => fileSet.has(`${prefix}${file}`)));
}

function rootNameForZip(archiveName: string, rootPrefix: string): string {
  const normalizedPrefix = rootPrefix.replace(/\/+$/, "");
  if (normalizedPrefix) {
    return normalizedPrefix.split("/").filter(Boolean).pop() ?? packageNameFromZipName(archiveName);
  }
  return packageNameFromZipName(archiveName);
}

async function sourceFromLoadedZip(
  zip: JSZip,
  archiveName: string,
  sourcePath?: string,
  packagePath?: string
): Promise<ImportFileSource> {
  const entries = zipEntries(zip);
  const fileEntries = entries.filter(({ entry }) => !entry.dir);
  const filePaths = fileEntries.map(({ path }) => path);
  const rootPrefix = packagePath ? findZipRootPrefixForPath(filePaths, packagePath) : findZipRootPrefix(filePaths);
  if (rootPrefix === undefined) {
    throw new Error(`Package path "${packagePath}" was not found in the archive`);
  }
  const fileMap = new Map(fileEntries.map(({ path, entry }) => [path, entry]));
  const directoryPaths = new Set(
    entries
      .filter(({ entry }) => entry.dir)
      .map(({ path }) => normalizeImportPath(path))
      .filter(Boolean)
  );

  return {
    rootName: rootNameForZip(archiveName, rootPrefix),
    sourcePath,
    readText: async (relativePath) => {
      const entry = fileMap.get(`${rootPrefix}${normalizeImportPath(relativePath)}`);
      if (!entry) throw new Error("File not found in zip");
      return entry.async("text");
    },
    readBytes: async (relativePath) => {
      const entry = fileMap.get(`${rootPrefix}${normalizeImportPath(relativePath)}`);
      if (!entry) throw new Error("File not found in zip");
      return entry.async("uint8array");
    },
    listFiles: async () =>
      filePaths
        .filter((path) => path.startsWith(rootPrefix))
        .map((path) => path.slice(rootPrefix.length))
        .map(normalizeImportPath)
        .filter(isRootPath)
        .sort((a, b) => a.localeCompare(b)),
    hasDirectory: async (relativePath) => {
      const directoryPath = normalizeImportPath(`${rootPrefix}${normalizeImportPath(relativePath)}`);
      return directoryPaths.has(directoryPath) || filePaths.some((path) => path.startsWith(`${directoryPath}/`));
    }
  };
}

export async function sourceFromZipBytes(
  archiveName: string,
  bytes: ArrayBuffer | Uint8Array,
  sourcePath?: string
): Promise<ImportFileSource> {
  const zip = await JSZip.loadAsync(bytes);
  return sourceFromLoadedZip(zip, archiveName, sourcePath);
}

export async function sourceFromZipBytesAtPath(
  archiveName: string,
  bytes: ArrayBuffer | Uint8Array,
  packagePath: string,
  sourcePath?: string
): Promise<ImportFileSource> {
  const zip = await JSZip.loadAsync(bytes);
  return sourceFromLoadedZip(zip, archiveName, sourcePath, packagePath);
}

export async function sourceFromZipFile(file: File): Promise<ImportFileSource> {
  return sourceFromZipBytes(file.name, await file.arrayBuffer(), file.name);
}

export async function selectTauriFolderSource(): Promise<ImportFileSource | undefined> {
  if (!isTauriRuntime()) return undefined;

  const dialog = await import("@tauri-apps/plugin-dialog");
  const fs = await import("@tauri-apps/plugin-fs");
  const selected = await dialog.open({
    directory: true,
    multiple: false,
    title: "Select perf-import folder"
  });

  if (!selected || Array.isArray(selected)) return undefined;
  const rootName = selected.split(/[\\/]/).filter(Boolean).pop() ?? "perf-import";

  return {
    rootName,
    sourcePath: selected,
    readText: (relativePath) => fs.readTextFile(joinPath(selected, relativePath)),
    readBytes: (relativePath) => fs.readFile(joinPath(selected, relativePath)),
    listFiles: async () => {
      const entries = await fs.readDir(selected);
      return entries
        .filter((entry) => entry.isFile)
        .map((entry) => normalizeImportPath(entry.name))
        .filter(isRootPath)
        .sort((a, b) => a.localeCompare(b));
    },
    hasDirectory: async (relativePath) => {
      try {
        await fs.readDir(joinPath(selected, relativePath));
        return true;
      } catch {
        return false;
      }
    }
  };
}

export async function selectTauriZipSource(): Promise<ImportFileSource | undefined> {
  if (!isTauriRuntime()) return undefined;

  const dialog = await import("@tauri-apps/plugin-dialog");
  const fs = await import("@tauri-apps/plugin-fs");
  const selected = await dialog.open({
    directory: false,
    multiple: false,
    title: "Select perf-import zip",
    filters: [{ name: "Zip archives", extensions: ["zip"] }]
  });

  if (!selected || Array.isArray(selected)) return undefined;
  return sourceFromZipBytes(fileNameFromPath(selected), await fs.readFile(selected), selected);
}

export function sourceFromFileList(files: FileList): ImportFileSource {
  const fileMap = new Map<string, File>();
  const first = files[0];
  const firstPath = first?.webkitRelativePath || first?.name || "perf-import";
  const rootName = firstPath.split("/")[0] || "perf-import";

  Array.from(files).forEach((file) => {
    const relativePath = file.webkitRelativePath
      ? file.webkitRelativePath.split("/").slice(1).join("/")
      : file.name;
    fileMap.set(relativePath, file);
  });

  return {
    rootName,
    readText: async (relativePath) => {
      const file = fileMap.get(relativePath);
      if (!file) throw new Error("File not selected");
      return file.text();
    },
    readBytes: async (relativePath) => {
      const file = fileMap.get(relativePath);
      if (!file) throw new Error("File not selected");
      return new Uint8Array(await file.arrayBuffer());
    },
    listFiles: async () =>
      [...fileMap.keys()]
        .map(normalizeImportPath)
        .filter(isRootPath)
        .sort((a, b) => a.localeCompare(b))
  };
}
