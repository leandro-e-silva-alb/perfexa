import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import packageJson from "./package.json";

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version)
  },
  clearScreen: false,
  server: {
    strictPort: true,
    host: "127.0.0.1",
    port: 1420
  },
  envPrefix: ["VITE_", "TAURI_"]
});
