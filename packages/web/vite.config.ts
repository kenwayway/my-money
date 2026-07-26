import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Ports overridable so two dev stacks can run side by side (e.g. two sessions)
const apiPort = Number(process.env.MY_MONEY_API_PORT ?? 4321);

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.MY_MONEY_WEB_PORT ?? 5173),
    proxy: {
      "/api": `http://localhost:${apiPort}`,
    },
  },
});
