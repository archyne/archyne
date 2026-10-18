import { defineConfig } from "vite";

/**
 * The host half of Generate (src/ai/host), as one CommonJS file for Node:
 * Electron's main process requires it, and the VS Code extension carries a
 * copy. Built as an SSR bundle so it targets Node rather than a browser; it
 * bundles its one dependency (oauth4webapi), so the output is self-contained.
 */
export default defineConfig({
  // The web app's static files belong to the web app, not to this bundle.
  publicDir: false,
  // Everything bundled in, oauth4webapi included: the VS Code extension
  // carries this one file and no node_modules beside it. Node's own modules
  // (node:http for the sign-in loopback) stay external, as they must.
  ssr: { noExternal: true },
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
