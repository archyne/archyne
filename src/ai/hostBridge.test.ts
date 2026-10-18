import { describe, expect, it } from "vitest";
import { hostProvider, type HostAi } from "./hostBridge";
import type { HostEvent } from "./host/core";

/**
 * The page's side of the host engine, against a scripted host: what reaches
 * the store is text, an error the panel can explain, or an AbortError — and a
 * Stop reaches the host.
 */

function scriptedHost(script: (requestId: string, emit: (e: HostEvent) => void) => void): {
  ai: HostAi;
  cancelled: string[];
  chats: Array<{ id: string; model: string }>;
} {
  const listeners = new Set<(e: HostEvent) => void>();
  const cancelled: string[] = [];
  const chats: Array<{ id: string; model: string }> = [];
  const emit = (e: HostEvent) => listeners.forEach((l) => l(e));
  const ai: HostAi = {
    setConnections: async () => {},
    setSecret: async () => {},
    secretFields: async () => [],
    canKeepSecrets: async () => true,
    probe: async () => ({ state: "down" }),
    chat: async (requestId, id, model) => {
      chats.push({ id, model });
      script(requestId, emit);
    },
    cancel: (requestId) => {
      cancelled.push(requestId);
      emit({ type: "ai:error", requestId, reason: "aborted", detail: "" });
    },
    onEvent: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  return { ai, cancelled, chats };
}

const MSG = [{ role: "user" as const, content: "draw" }];

describe("hostProvider", () => {
  it("streams the host's text and resolves with the whole answer", async () => {
    const { ai, chats } = scriptedHost((requestId, emit) => {
      emit({ type: "ai:chunk", requestId, text: "flow" });
      emit({ type: "ai:chunk", requestId, text: "flowchart TD" });
      emit({ type: "ai:done", requestId, text: "flowchart TD" });
    });
    const seen: string[] = [];
    const text = await hostProvider(ai, "gw", "m1").generate(MSG, {
      onToken: (t) => seen.push(t),
    });
    expect(text).toBe("flowchart TD");
    expect(seen).toEqual(["flow", "flowchart TD"]);
    expect(chats).toEqual([{ id: "gw", model: "m1" }]);
  });

  it("ignores events that belong to another request", async () => {
    const { ai } = scriptedHost((requestId, emit) => {
      emit({ type: "ai:done", requestId: "someone-else", text: "not mine" });
      emit({ type: "ai:done", requestId, text: "mine" });
    });
    expect(await hostProvider(ai, "gw", "m").generate(MSG)).toBe("mine");
  });

  it("turns a host error into a ServerError the panel can explain", async () => {
    const { ai } = scriptedHost((requestId, emit) =>
      emit({ type: "ai:error", requestId, reason: "not-local", detail: "plain http" }),
    );
    await expect(hostProvider(ai, "gw", "m").generate(MSG)).rejects.toMatchObject({
      name: "ServerError",
      reason: "not-local",
    });
  });

  it("passes Stop to the host and comes back as an AbortError", async () => {
    const { ai, cancelled } = scriptedHost(() => {});
    const ctrl = new AbortController();
    const run = hostProvider(ai, "gw", "m").generate(MSG, { signal: ctrl.signal });
    await Promise.resolve();
    await Promise.resolve();
    ctrl.abort();
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled).toHaveLength(1);
  });

  it("waits for the host to know the connection before asking it anything", async () => {
    const order: string[] = [];
    const { ai } = scriptedHost((requestId, emit) => {
      order.push("chat");
      emit({ type: "ai:done", requestId, text: "x" });
    });
    await hostProvider(ai, "gw", "m", async () => {
      order.push("synced");
    }).generate(MSG);
    expect(order).toEqual(["synced", "chat"]);
  });

  it("refuses to run without a model", async () => {
    const { ai, chats } = scriptedHost(() => {});
    await expect(hostProvider(ai, "gw", "").generate(MSG)).rejects.toMatchObject({
      reason: "no-model",
    });
    expect(chats).toHaveLength(0);
  });
});
