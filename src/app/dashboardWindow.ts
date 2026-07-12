const DASHBOARD_WINDOW_LABEL = "perfexa-dashboard";

function dashboardUrl(): string {
  return `${window.location.href.split("#")[0]}#/dashboard`;
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

export async function openDashboardWindow(): Promise<void> {
  const url = dashboardUrl();

  if (isTauriRuntime()) {
    try {
      const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      const existing = await WebviewWindow.getByLabel(DASHBOARD_WINDOW_LABEL);
      if (existing) {
        await existing.show();
        await existing.setFocus();
        return;
      }

      const dashboardWindow = new WebviewWindow(DASHBOARD_WINDOW_LABEL, {
        url,
        title: "Perfexa Dashboard",
        width: 1240,
        height: 820,
        minWidth: 960,
        minHeight: 640,
        center: true,
        focus: true
      });
      dashboardWindow.once("tauri://error", (event) => {
        console.error("Unable to open dashboard window.", event.payload);
      });
      return;
    } catch (error) {
      console.error("Unable to open Tauri dashboard window.", error);
    }
  }

  window.open(url, "perfexa-dashboard", "popup,width=1240,height=820");
}
