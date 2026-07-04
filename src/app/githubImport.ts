export interface GitHubImportConfig {
  apiBaseUrl: string;
  owner: string;
  repo: string;
  refName: string;
  packagePath: string;
}

export interface GitHubArchiveDownload {
  archiveName: string;
  sourceLabel: string;
  bytes: number[];
}

export const defaultGitHubImportConfig: GitHubImportConfig = {
  apiBaseUrl: "https://api.github.com",
  owner: "",
  repo: "",
  refName: "main",
  packagePath: ""
};

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

export function githubCredentialAccount(apiBaseUrl: string): string {
  try {
    return new URL(apiBaseUrl).host.toLowerCase();
  } catch {
    return "github";
  }
}

async function invokeCommand<T>(command: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

export async function hasStoredGitHubToken(account: string): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  return invokeCommand<boolean>("has_github_token", { account });
}

export async function saveGitHubToken(account: string, token: string): Promise<void> {
  if (!isTauriRuntime()) throw new Error("GitHub imports require the desktop app.");
  await invokeCommand<void>("save_github_token", { account, token });
}

export async function clearGitHubToken(account: string): Promise<void> {
  if (!isTauriRuntime()) throw new Error("GitHub imports require the desktop app.");
  await invokeCommand<void>("clear_github_token", { account });
}

export async function downloadGitHubArchive(
  account: string,
  config: GitHubImportConfig
): Promise<GitHubArchiveDownload> {
  if (!isTauriRuntime()) throw new Error("GitHub imports require the desktop app.");
  return invokeCommand<GitHubArchiveDownload>("download_github_archive", {
    request: {
      account,
      apiBaseUrl: config.apiBaseUrl,
      owner: config.owner,
      repo: config.repo,
      refName: config.refName
    }
  });
}
