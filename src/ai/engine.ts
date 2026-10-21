import { create } from "zustand";
import { useI18n } from "../i18n";
import { hostAi } from "./hostBridge";
import type { Connection } from "./host/connection";
import { newConnectionId } from "./host/connection";
import { aiMode } from "./mode";
import { SERVER_PRESETS, type ServerSettings } from "./server";
import type { VaultKind } from "./host/vault";

/**
 * Which engine answers a Generate request, and how to reach the services that
 * are not in the page.
 *
 * Kept in the browser's storage under its own key, apart from the editing
 * preferences in `prefs.ts`: these are about outside programs the person
 * runs or uses. Nothing secret is stored here — keys and passwords live in
 * the host (desktop/ai.cjs, extensions/vscode/src/ai.ts) and never come back.
 *
 *   - `browser`: the engine this build carries — the in-tab model in a
 *     `local` build, the stub on a dev server. Not offered when the build
 *     carries none (`off`).
 *   - `server`: an OpenAI-compatible server on this machine (`server.ts`).
 *     Always available. In the desktop app and VS Code it is reached through
 *     the host like a remote service, which spares it the page's CORS.
 *   - `remote`: a service anywhere, with credentials — desktop and VS Code
 *     only, because only a host can keep a secret (AUTH.local.md).
 *
 * Vaults are listed beside the services: places a service's secrets can be
 * read from instead of being kept on this computer (AUTH.local.md, phase 5).
 * To the host they are connections too, with protocol `vault`.
 */
export type AiEngine = "browser" | "server" | "remote";

const STORAGE_KEY = "graph:ai-engine";

/** The connection id the local server goes by when the host carries it. */
export const LOCAL_CONNECTION_ID = "local";

interface Stored {
  engine?: AiEngine;
  server?: Partial<ServerSettings>;
  connections?: Connection[];
  connectionId?: string | null;
  vaults?: Connection[];
}

interface EngineState {
  engine: AiEngine;
  server: ServerSettings;
  connections: Connection[];
  connectionId: string | null;
  setEngine: (engine: AiEngine) => void;
  setServer: (patch: Partial<ServerSettings>) => void;
  /** Adds an empty connection, selects it, and returns its id. */
  addConnection: (label: string) => string;
  updateConnection: (id: string, patch: Partial<Connection>) => void;
  removeConnection: (id: string) => void;
  selectConnection: (id: string) => void;
  vaults: Connection[];
  /** Adds a vault read through its CLI, and returns its id. */
  addVault: (label: string, kind: VaultKind) => string;
  updateVault: (id: string, patch: Partial<Connection>) => void;
  /** Removes a vault, and every reference a service had to it. */
  removeVault: (id: string) => void;
}

/** Whether this build carries an engine of its own for the `browser` choice. */
export function browserEngineAvailable(): boolean {
  return aiMode() !== "off";
}

/** Whether a host can carry remote services (desktop, VS Code). */
export function remoteEngineAvailable(): boolean {
  return hostAi() !== null;
}

function load(): Stored {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Stored) : {};
  } catch {
    return {};
  }
}

const DEFAULT_SERVER: ServerSettings = {
  baseUrl: SERVER_PRESETS.ollama.baseUrl,
  model: "",
  apiKey: "",
};

/** The stored choice, made safe for the build and the shell it is read in. */
export function initialEngine(
  stored: Stored,
  browserAvailable: boolean,
  remoteAvailable = false,
): AiEngine {
  if (stored.engine === "server") return "server";
  if (stored.engine === "remote" && remoteAvailable) return "remote";
  return browserAvailable ? "browser" : "server";
}

/** The local server, described as a connection for the host to carry. */
export function localConnection(server: ServerSettings): Connection {
  return {
    id: LOCAL_CONNECTION_ID,
    label: "Local server",
    baseUrl: server.baseUrl,
    protocol: "openai",
    auth: { type: "none" },
    model: server.model,
  };
}

let lastSync: Promise<void> = Promise.resolve();

/**
 * Tell the host which connections exist. Every host call waits for the last
 * of these first (`hostSynced`), so a probe right after an edit never asks
 * about the connection as it was a moment ago.
 */
function syncHost(state: Pick<EngineState, "server" | "connections" | "vaults">): void {
  const ai = hostAi();
  if (!ai) return;
  const list = [localConnection(state.server), ...state.connections, ...state.vaults];
  // The language goes along for the questions the host asks in its own window.
  const locale = useI18n.getState().locale;
  lastSync = lastSync.then(() => ai.setConnections(list, locale)).catch(() => undefined);
}

/** Resolves once the host has the connections as they stand now. */
export function hostSynced(): Promise<void> {
  return lastSync;
}

const stored = load();

export const useAiEngine = create<EngineState>((set, get) => {
  const persist = () => {
    const { engine, server, connections, connectionId, vaults } = get();
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ engine, server, connections, connectionId, vaults }),
      );
    } catch {
      // Storage unavailable; the choice still holds for this session.
    }
  };
  const changed = () => {
    persist();
    syncHost(get());
  };
  const connections = Array.isArray(stored.connections) ? stored.connections : [];
  const vaults = Array.isArray(stored.vaults)
    ? stored.vaults.filter((v) => v.protocol === "vault")
    : [];
  const initial = {
    vaults,
    engine: initialEngine(stored, browserEngineAvailable(), remoteEngineAvailable()),
    server: { ...DEFAULT_SERVER, ...stored.server },
    connections,
    connectionId:
      stored.connectionId && connections.some((c) => c.id === stored.connectionId)
        ? stored.connectionId
        : (connections[0]?.id ?? null),
  };
  syncHost(initial);
  return {
    ...initial,
    setEngine: (engine) => {
      if (engine === "browser" && !browserEngineAvailable()) return;
      if (engine === "remote" && !remoteEngineAvailable()) return;
      set({ engine });
      persist();
    },
    setServer: (patch) => {
      set({ server: { ...get().server, ...patch } });
      changed();
    },
    addConnection: (label) => {
      const id = newConnectionId();
      const fresh: Connection = {
        id,
        label,
        baseUrl: "https://",
        protocol: "openai",
        auth: { type: "header", name: "Authorization", prefix: "Bearer " },
      };
      set({ connections: [...get().connections, fresh], connectionId: id });
      changed();
      return id;
    },
    updateConnection: (id, patch) => {
      set({
        connections: get().connections.map((c) => (c.id === id ? { ...c, ...patch, id } : c)),
      });
      changed();
    },
    removeConnection: (id) => {
      const rest = get().connections.filter((c) => c.id !== id);
      set({
        connections: rest,
        connectionId: get().connectionId === id ? (rest[0]?.id ?? null) : get().connectionId,
      });
      changed();
    },
    selectConnection: (id) => {
      set({ connectionId: id });
      persist();
    },
    addVault: (label, kind) => {
      const id = newConnectionId();
      const fresh: Connection = {
        id,
        label,
        baseUrl: "https://",
        protocol: "vault",
        auth: { type: "none" },
        vault: { kind, via: "cli" },
      };
      set({ vaults: [...get().vaults, fresh] });
      changed();
      return id;
    },
    updateVault: (id, patch) => {
      set({
        vaults: get().vaults.map((v) =>
          v.id === id ? { ...v, ...patch, id, protocol: "vault" as const } : v,
        ),
      });
      changed();
    },
    removeVault: (id) => {
      set({
        vaults: get().vaults.filter((v) => v.id !== id),
        connections: get().connections.map((c) => {
          if (!c.fromVault) return c;
          const kept = Object.fromEntries(
            Object.entries(c.fromVault).filter(([, ref]) => ref.vault !== id),
          );
          return { ...c, fromVault: Object.keys(kept).length ? kept : undefined };
        }),
      });
      changed();
    },
  };
});

// A change of language reaches the host too, for the next question it asks.
useI18n.subscribe((now, before) => {
  if (now.locale !== before.locale) syncHost(useAiEngine.getState());
});
