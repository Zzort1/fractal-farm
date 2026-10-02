import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In development the browser talks to Vite, which forwards tile and API calls
// to the local API — one origin, as CloudFront will provide in production.
const api = process.env.API_ORIGIN || "http://localhost:8787";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/tiles": api,
      "/api": api,
      "/healthz": api,
    },
  },
});
