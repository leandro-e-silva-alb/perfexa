export type AppView =
  | "package-import"
  | "package-library"
  | "scenario-board"
  | "run-explorer"
  | "test-metrics"
  | "sizing-models"
  | "test-compare";

const packageViewRoutes: Record<Exclude<AppView, "package-import" | "package-library">, string> = {
  "scenario-board": "scenarios",
  "run-explorer": "runs",
  "test-metrics": "metrics",
  "sizing-models": "sizing-models",
  "test-compare": "compare"
};

const packageViewByRoute = new Map(
  Object.entries(packageViewRoutes).map(([view, route]) => [route, view as AppView])
);

export function routeForView(view: AppView, packageId?: string): string {
  if (view === "package-import") return "/import";
  if (view === "package-library") return "/library";
  if (!packageId) return "/library";

  return `/packages/${encodeURIComponent(packageId)}/${packageViewRoutes[view]}`;
}

export function viewFromPathname(pathname: string): AppView {
  if (pathname === "/library") return "package-library";
  if (pathname === "/import") return "package-import";

  const packageViewRoute = pathname.match(/^\/packages\/[^/]+\/([^/?#]+)/)?.[1];
  return packageViewByRoute.get(packageViewRoute ?? "") ?? "package-import";
}

export function packageIdFromPathname(pathname: string): string | undefined {
  const encodedId = pathname.match(/^\/packages\/([^/]+)/)?.[1];
  if (!encodedId) return undefined;

  try {
    return decodeURIComponent(encodedId);
  } catch {
    return encodedId;
  }
}

export function testKeysFromSearch(search: string): string[] {
  const params = new URLSearchParams(search);
  return [...new Set(params.getAll("test").filter(Boolean))];
}

export function withTestKeys(path: string, testKeys: string[]): string {
  const params = new URLSearchParams();
  for (const testKey of [...new Set(testKeys)].filter(Boolean)) {
    params.append("test", testKey);
  }

  const query = params.toString();
  return query ? `${path}?${query}` : path;
}
