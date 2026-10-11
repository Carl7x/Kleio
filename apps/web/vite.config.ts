import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL("./", import.meta.url)),
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: process.env.KLEIO_API_URL ?? "http://127.0.0.1:4317",
        changeOrigin: true,
      },
    },
  },
  build: { target: "es2023" },
});
