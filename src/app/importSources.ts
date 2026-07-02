import type { ImportFileSource } from "../domain/types";

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

function joinPath(root: string, relativePath: string): string {
  const separator = root.includes("\\") ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${separator}${relativePath.replace(/\//g, separator)}`;
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
    }
  };
}
