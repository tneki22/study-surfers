import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Общая демо-колода лежит вне frontend/ — её читают и бэкенд, и mock-режим.
      "@fixtures": fileURLToPath(new URL("../fixtures", import.meta.url)),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5180,
    strictPort: true,
    fs: { allow: [".."] },
    proxy: {
      "/api": {
        target: process.env.SS_API_URL ?? "http://127.0.0.1:8765",
        changeOrigin: true,
      },
    },
  },
});
