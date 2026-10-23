/**
 * Copy the built editor into the extension, so the `.vsix` carries it.
 *
 * The extension is a shell: the diagram editor inside it is the same bundle
 * the web app and the desktop shell run, taken from the repository root's
 * `dist/`. Copying rather than reaching up at runtime is what makes the
 * packaged extension self-contained — at run time there is no repository
 * above it to reach into.
 */
import { cp, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, "..", "..", "..", "dist");
const target = resolve(here, "..", "media", "app");

try {
  await stat(resolve(source, "index.html"));
} catch {
  console.error(
    `No build to bundle: ${source} has no index.html.\n` +
      `Run \`npm run build\` at the repository root first — the extension ships ` +
      `the app, it does not build it.`,
  );
  process.exit(1);
}

// Cleared first: vite's filenames carry a content hash, so a stale build would
// otherwise leave its chunks behind and quietly inflate every package.
await rm(target, { recursive: true, force: true });
await cp(source, target, { recursive: true });

console.log(`Bundled the editor into ${target}`);

// Generate's host side (src/ai/host, built to dist-host/ai-host.cjs): the
// extension host runs it, so the webview never holds a secret. The same file
// the desktop app runs — see src/ai.ts.
const hostSource = resolve(here, "..", "..", "..", "dist-host", "ai-host.cjs");
const hostTarget = resolve(here, "..", "media", "host", "ai-host.cjs");
try {
  await stat(hostSource);
} catch {
  console.error(`No ${hostSource}: run \`npm run build\` at the repository root first.`);
  process.exit(1);
}
await rm(dirname(hostTarget), { recursive: true, force: true });
await cp(hostSource, hostTarget);

console.log(`Bundled Generate's host into ${hostTarget}`);
