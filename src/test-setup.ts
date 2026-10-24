import { beforeEach } from "vitest";

/**
 * A complete `localStorage` for the test environment.
 *
 * jsdom under this setup provides something Storage-shaped but incomplete —
 * `clear()` is missing, and Node's own experimental web storage may be what
 * actually answers. Tests that persist anything were each stubbing their own
 * replacement, which is duplication that drifts.
 *
 * It is also emptied between tests: persistence bugs where one test's
 * leftovers change another's outcome are exactly what a workspace store
 * would otherwise hide.
 */
const store = new Map<string, string>();

const storage: Storage = {
  get length() {
    return store.size;
  },
  key: (i: number) => [...store.keys()][i] ?? null,
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
};

Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });

/**
 * A canvas that admits it has no context, quietly.
 *
 * `textMetrics()` asks for a 2D context to measure text with, and falls back to
 * its approximation when there is none — which under jsdom there never is,
 * because the optional `canvas` package is not installed and is not wanted for
 * this. jsdom answers `null`, which is correct, but shouts "Not implemented:
 * HTMLCanvasElement's getContext()" through the virtual console on the way,
 * once per test file that measures anything. Fourteen lines of that in a green
 * run reads like something is broken.
 *
 * So the answer is given directly. This changes nothing about what runs: `null`
 * is what jsdom returns anyway, and the fallback engages exactly as it does in
 * a real environment without a canvas.
 */
// Only where there is a DOM: a test that asks for the plain Node environment
// (src/ai/host/oauth.test.ts, whose crypto must not cross into jsdom's realm)
// has no canvas to quieten.
if (typeof HTMLCanvasElement !== "undefined") {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => null,
  });
}

beforeEach(() => {
  store.clear();
});
