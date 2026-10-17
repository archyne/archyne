import { create } from "zustand";
import { aiMode } from "./mode";
import { SERVER_PRESETS, type ServerSettings } from "./server";

/**
 * Which engine answers a Generate request, and how to reach the local server
 * when that is the one.
 *
 * Kept in the browser's storage under its own key, apart from the editing
 * preferences in `prefs.ts`: these are about an outside program the person
 * runs, and losing them (a cleared profile, a private window) costs nothing
 * worse than picking the server again.
 *
 *   - `browser`: the engine this build carries — the in-tab model in a
 *     `local` build, the stub on a dev server. Not offered when the build
 *     carries none (`off`).
 *   - `server`: an OpenAI-compatible server on this machine (`server.ts`).
 *     Always available, which is what lets a release build offer Generate
 *     at all without shipping a model.
 */
export type AiEngine = "browser" | "server";

const STORAGE_KEY = "graph:ai-engine";

interface Stored {
  engine?: AiEngine;
  server?: Partial<ServerSettings>;
}

interface EngineState {
  engine: AiEngine;
  server: ServerSettings;
  setEngine: (engine: AiEngine) => void;
  setServer: (patch: Partial<ServerSettings>) => void;
}

/** Whether this build carries an engine of its own for the `browser` choice. */
export function browserEngineAvailable(): boolean {
  return aiMode() !== "off";
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

/** The stored choice, made safe for the build it is read in. */
export function initialEngine(stored: Stored, browserAvailable: boolean): AiEngine {
  if (!browserAvailable) return "server";
  return stored.engine === "server" ? "server" : "browser";
}

const stored = load();

export const useAiEngine = create<EngineState>((set, get) => {
  const persist = () => {
    const { engine, server } = get();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ engine, server }));
    } catch {
      // Storage unavailable; the choice still holds for this session.
    }
  };
  return {
    engine: initialEngine(stored, browserEngineAvailable()),
    server: { ...DEFAULT_SERVER, ...stored.server },
    setEngine: (engine) => {
      if (engine === "browser" && !browserEngineAvailable()) return;
      set({ engine });
      persist();
    },
    setServer: (patch) => {
      set({ server: { ...get().server, ...patch } });
      persist();
    },
  };
});
