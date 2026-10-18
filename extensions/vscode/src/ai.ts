import * as path from "node:path";
import * as vscode from "vscode";
import { answerCall, type AiHostLike, type Call } from "./aiCalls";

/**
 * The extension host's side of Generate.
 *
 * The page in the webview never holds a secret: it sends a connection id and
 * a conversation, and this side adds the credentials, makes the request and
 * streams the answer back (AUTH.local.md in the repository, "The one rule").
 * The logic is the repository's `src/ai/host`, built to `ai-host.cjs` and
 * copied into `media/host/` by scripts/bundle-app.mjs — the same file the
 * desktop app runs. What is particular to VS Code is supplied here:
 *
 *   - secrets in `context.secrets` (SecretStorage, the OS keychain behind
 *     it). Connections themselves stay in the webview's storage and are not
 *     synced between machines — Dario's call, 2026-10-18;
 *   - Node's `fetch`, which VS Code's proxy support covers.
 */

let context: vscode.ExtensionContext | null = null;
let host: AiHostLike | null = null;

/** Called once from `activate`, so each webview can attach without threading it through. */
export function setAiContext(ctx: vscode.ExtensionContext): void {
  context = ctx;
}

function aiHost(): AiHostLike {
  if (host) return host;
  if (!context) throw new Error("The extension is not active.");
  const ctx = context;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require(path.join(ctx.extensionPath, "media", "host", "ai-host.cjs")) as {
    AiHost: new (env: unknown) => AiHostLike;
  };
  host = new mod.AiHost({
    fetch: globalThis.fetch,
    secrets: {
      get: (key: string) => Promise.resolve(ctx.secrets.get(key)),
      set: (key: string, value: string) => Promise.resolve(ctx.secrets.store(key, value)),
      delete: (key: string) => Promise.resolve(ctx.secrets.delete(key)),
    },
  });
  return host;
}

/** Answer one webview's Generate calls; the dispatch itself is in aiCalls.ts. */
export function attachAi(webview: vscode.Webview): vscode.Disposable {
  return webview.onDidReceiveMessage((msg: Call) =>
    answerCall(aiHost, msg, (message) => void webview.postMessage(message)),
  );
}
