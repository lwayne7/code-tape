import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const isGitHubPagesBuild = process.env.GITHUB_PAGES === "true";

export default defineConfig({
  base: isGitHubPagesBuild ? "/code-tape/" : "/",
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5173,
    strictPort: false,
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
  worker: {
    format: "es",
  },
});
