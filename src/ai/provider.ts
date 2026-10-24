import { hostSynced, LOCAL_CONNECTION_ID, useAiEngine } from "./engine";
import { hostAi, hostProvider } from "./hostBridge";
import { fakeProvider } from "./fake";
import { aiMode } from "./mode";
import { isLocalUrl, serverProvider } from "./server";
import type { LocalStatus } from "./transformers";
import { workerEngine } from "./workerEngine";
import type { AiProvider } from "./types";

export { aiMode, resolveAiMode, type AiMode } from "./mode";

/** The one local engine the page runs; created the first time it is asked. */
let local: AiProvider | null = null;

/**
 * The provider this build can run, or null when no model is connected.
 *
 * The local engine is a singleton: its state — which model is loaded — is the
 * page's state, shared by every turn. The status callback is captured at
 * creation; the store passes the same listener on every call.
 */
export function getProvider(onStatus?: (status: LocalStatus) => void): AiProvider | null {
  // A local server is chosen at run time and works in every build; the
  // settings are read per request, so an edited address takes effect at once.
  const { engine, server, connections, connectionId } = useAiEngine.getState();
  const ai = hostAi();
  if (engine === "remote") {
    const connection = connections.find((c) => c.id === connectionId);
    if (!ai || !connection) return null;
    return hostProvider(ai, connection.id, connection.model ?? "", hostSynced);
  }
  if (engine === "server") {
    // Through the host when there is one: it has no CORS to satisfy, so
    // LM Studio works without its CORS switch and the desktop's file://
    // page is no longer refused by Ollama.
    return ai && isLocalUrl(server.baseUrl)
      ? hostProvider(ai, LOCAL_CONNECTION_ID, server.model, hostSynced)
      : serverProvider({ ...server });
  }
  if (aiMode() === "stub") return fakeProvider;
  if (aiMode() === "local") {
    local ??= workerEngine({ onStatus });
    return local;
  }
  return null;
}
