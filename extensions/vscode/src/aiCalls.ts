/**
 * The webview's Generate calls, answered — without the `vscode` module, so
 * the repository's test runner can drive it with the real shared host
 * (aiCalls.test.ts). `ai.ts` is the glue that hands it a webview.
 *
 * A call is `{ type: "ai:call", callId, method, args }` and is answered with
 * `{ type: "ai:result", callId, ok, value | error }`; a chat streams its text
 * as `{ type: "ai:event", event }` while the call is still open. The method
 * names mirror the desktop's preload bridge (desktop/preload.cjs), so the
 * page's side (src/ai/hostBridge.ts) is the same for both hosts.
 */

/** The slice of the shared host this file calls; see src/ai/host/core.ts. */
export interface AiHostLike {
  setConnections(list: unknown[], locale?: unknown): Promise<void>;
  setSecret(id: string, field: string, value: string | null): Promise<void>;
  secretFields(id: string): Promise<string[]>;
  probe(id: string): Promise<unknown>;
  chat(
    requestId: string,
    id: string,
    model: string,
    messages: unknown[],
    emit: (event: unknown) => void,
  ): Promise<void>;
  cancel(requestId: string): void;
  signIn(id: string, emit: (event: unknown) => void): Promise<void>;
  cancelSignIn(id: string): void;
  signOut(id: string): Promise<void>;
  authStatus(id: string): Promise<unknown>;
  importSecretFile(id: string, field: string): Promise<unknown>;
}

export interface Call {
  type?: unknown;
  callId?: unknown;
  method?: unknown;
  args?: unknown;
}

export async function answerCall(
  host: () => AiHostLike,
  msg: Call,
  post: (message: unknown) => void,
): Promise<void> {
  if (msg?.type !== "ai:call" || typeof msg.callId !== "number") return;
  const args = Array.isArray(msg.args) ? (msg.args as unknown[]) : [];
  const reply = (ok: boolean, payload: { value?: unknown; error?: string }) =>
    post({ type: "ai:result", callId: msg.callId, ok, ...payload });
  try {
    const h = host();
    let value: unknown;
    switch (msg.method) {
      case "setConnections":
        value = await h.setConnections(Array.isArray(args[0]) ? args[0] : [], args[1]);
        break;
      case "setSecret":
        value = await h.setSecret(
          String(args[0]),
          String(args[1]),
          args[2] === null ? null : String(args[2]),
        );
        break;
      case "secretFields":
        value = await h.secretFields(String(args[0]));
        break;
      case "canKeepSecrets":
        // SecretStorage always has a backend; VS Code chooses it.
        value = true;
        break;
      case "probe":
        value = await h.probe(String(args[0]));
        break;
      case "chat":
        value = await h.chat(
          String(args[0]),
          String(args[1]),
          String(args[2]),
          Array.isArray(args[3]) ? args[3] : [],
          (event) => post({ type: "ai:event", event }),
        );
        break;
      case "cancel":
        h.cancel(String(args[0]));
        break;
      // OAuth: progress streams as ai:event like a chat's text; the tokens
      // stay in the extension host.
      case "signIn":
        value = await h.signIn(String(args[0]), (event) => post({ type: "ai:event", event }));
        break;
      case "cancelSignIn":
        h.cancelSignIn(String(args[0]));
        break;
      case "signOut":
        value = await h.signOut(String(args[0]));
        break;
      case "authStatus":
        value = await h.authStatus(String(args[0]));
        break;
      case "importSecretFile":
        value = await h.importSecretFile(String(args[0]), String(args[1]));
        break;
      default:
        throw new Error("Unknown call.");
    }
    reply(true, { value });
  } catch (err) {
    reply(false, { error: err instanceof Error ? err.message : String(err) });
  }
}
