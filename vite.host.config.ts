import { defineConfig } from "vite";

/**
 * The host half of Generate (src/ai/host), as one CommonJS file for Node:
 * Electron's main process requires it, and the VS Code extension carries a
 * copy. Built as an SSR bundle so it targets Node rather than a browser; it
 * imports nothing from node_modules, so the output is self-contained.
 */
export default defineConfig({
  // The web app's static files belong to the web app, not to this bundle.
  publicDir: false,
  build: {
    ssr: "src/ai/host/index.ts",
    outDir: "dist-host",
    emptyOutDir: true,
    target: "node20",
    minify: false,
    rollupOptions: {
      output: { format: "cjs", entryFileNames: "ai-host.cjs" },
    },
  },
});
