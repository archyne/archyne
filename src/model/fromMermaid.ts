import type { Mermaid } from "mermaid";
// The light module, not `../icons`: that one holds the collection loaders, and
// the parse path must not carry a megabyte of icon data. Drawing *with*
// Mermaid — which needs the packs — lives in `./mermaidRender.ts` for the same
// reason: a dynamic import is emitted as a chunk if the module is reachable at
// all, so the loaders had to leave this file entirely, not merely go unused.

// mermaid is imported lazily: it is ~2 MB and (in Node) requires DOM globals
// to exist before the module is evaluated.
let mermaidPromise: Promise<Mermaid> | null = null;

/** The longest source mermaid will draw — see `maxTextSize` below. */
export const MAX_TEXT_SIZE = 5_000_000;

/**
 * mermaid's per-kind parser DBs are singletons cleared at the start of each
 * parse/render — two concurrent calls corrupt each other (empty results, no
 * error). Every mermaid operation must go through this lock.
 */
let chain: Promise<unknown> = Promise.resolve();
/**
 * Render with mermaid, having first told it what this diagram is drawn with.
 *
 * Both of the things done here exist because the canvas and the preview drew
 * *different pictures* of one file: the canvas knows the icons a diagram
 * carries and the names it can fall back on, and mermaid knew neither.
 *
 * Every route to mermaid's renderer goes through this — the preview tab, the
 * read-only view for families Archyne cannot edit, and export — so the two
 * views cannot drift apart again by somebody forgetting a step.
 */
export function withMermaid<T>(fn: (m: Mermaid) => Promise<T>): Promise<T> {
  const run = chain.then(async () => fn(await getMermaid()));
  chain = run.catch(() => undefined);
  return run;
}

export function getMermaid(): Promise<Mermaid> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((m) => {
      m.default.initialize({
        startOnLoad: false,
        // Diagram source is untrusted input: it arrives from `?code=` links,
        // the embed bridge's `load` message, and opened .mmd files, and the
        // rendered SVG is written straight into the DOM with innerHTML
        // (MermaidPreview).
        //
        // What this setting actually buys, measured against mermaid 11.9 —
        // labels are *not* it: `common.sanitizeText` runs DOMPurify over every
        // label at every security level, "loose" included. The live difference
        // is `utils.formatUrl`, which only calls `sanitizeUrl` when the level
        // is not "loose". So under "loose" a `click x href "javascript:…"`
        // lands in the rendered anchor verbatim, and a shared link becomes
        // one-click script execution in the app's origin; under "strict" it
        // becomes about:blank. (The other difference, `click x call fn()`, is
        // inert here either way — binding it requires calling mermaid's
        // `bindFunctions`, which Archyne never does.)
        //
        // The CSP in index.html blocks javascript: URLs too, but that is a
        // meta tag a self-hoster can drop or a proxy can rewrite; this is the
        // layer that must hold on its own. Archyne uses no `click`
        // interactions, so strict costs nothing — tests/e2e-csp.mts pins both
        // halves of that claim.
        //
        // `securityLevel` is on mermaid's `secure` list, so a `%%{init}%%`
        // directive inside a diagram cannot downgrade it back to "loose".
        securityLevel: "strict",
        // Never inject mermaid's own "Syntax error" bomb into the DOM —
        // the editor surfaces parse errors in its own banner.
        suppressErrorRendering: true,
        // Mermaid's own limit is 50,000 characters, past which it draws
        // "Maximum text size in diagram exceeded" instead of the diagram. A
        // picture carried in the file as a data URI is a few thousand on its
        // own, so a draw.io architecture of a dozen icons — aks-baseline, at
        // 57,000 — showed that in the preview and in export while the canvas
        // drew it whole. What makes a diagram slow to draw is its edges, which
        // `maxEdges` still caps; this one is on mermaid's `secure` list too, so
        // a `%%{init}%%` directive cannot change it.
        maxTextSize: MAX_TEXT_SIZE,
      });
      return m.default;
    });
  }
  return mermaidPromise;
}
