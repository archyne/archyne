/**
 * Whether somebody else is holding this diagram, and what follows from it.
 *
 * A leaf module on purpose: it imports nothing. The two questions here are
 * asked by `embed.ts` and by `workspace.ts`, and `embed.ts` reaches the store
 * which reaches `workspace.ts` — so answering them anywhere else would put a
 * cycle under a constant that is evaluated while the modules are still being
 * loaded.
 */

/** VS Code's webview API. Declared here because it exists nowhere else. */
interface VsCodeApi {
  postMessage(message: unknown): void;
}
declare global {
  interface Window {
    acquireVsCodeApi?: () => VsCodeApi;
  }
}

/** True inside a VS Code webview, where the extension host is the peer. */
export function inWebview(): boolean {
  return typeof window.acquireVsCodeApi === "function";
}

let vscode: VsCodeApi | null = null;

/**
 * The webview's one handle on the extension host.
 *
 * `acquireVsCodeApi()` may be called once per page — a second call throws —
 * and two features talk over it: the canvas bridge (`embed.ts`) and
 * Generate's host engine (`ai/hostBridge.ts`). So it is acquired here, once,
 * and shared.
 */
export function vscodeApi(): VsCodeApi | null {
  if (!inWebview()) return null;
  vscode ??= window.acquireVsCodeApi!();
  return vscode;
}

/**
 * True when Archyne is running inside something that hands it a diagram:
 * `?embed=1` in an iframe, or a VS Code webview, where there is no query
 * string to put it in and the presence of the API is the fact itself.
 */
export function isEmbedded(): boolean {
  if (inWebview()) return true;
  try {
    return new URLSearchParams(location.search).has("embed");
  } catch {
    return false;
  }
}

/**
 * True when the document belongs to the host, not to Archyne.
 *
 * In a VS Code webview the file is a `TextDocument` the editor owns: it holds
 * the dirty state, it decides when bytes reach the disk, and Ctrl+S is its
 * key. Archyne offering its own Save beside that is not a duplicate but a
 * contradiction — two buttons that write different things at different times.
 * The same goes for opening a file, and for the whole multi-document
 * workspace: a webview is bound to one document, and switching to another
 * behind the host's back would send that one's text back as an edit to the
 * file the host has open.
 *
 * So the controls those describe are hidden, and everything that edits the
 * diagram in front of you stays — the host is saving the result either way.
 */
export function hostOwnsFile(): boolean {
  return inWebview();
}
