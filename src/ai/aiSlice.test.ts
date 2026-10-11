import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useGraphStore } from "../store";
import { fakeProvider } from "./fake";
import { DEFAULT_AI_MODEL } from "./types";

const START = "flowchart TD\n  a[Start] --> b[Done]\n";

async function waitFor(cond: () => boolean, timeout = 8000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for the store");
    await new Promise((r) => setTimeout(r, 10));
  }
}

// The first layout pass drags Mermaid and the ELK engine into memory, which
// can outrun Vitest's default ten-second hook budget on a cold cache.
beforeEach(async () => {
  useGraphStore.setState({
    aiOpen: false,
    aiModel: DEFAULT_AI_MODEL,
    aiTurns: [],
    aiDocId: null,
  });
  await useGraphStore.getState().applyCode(START);
}, 60_000);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the Generate conversation slice", () => {
  it("starts shut, on the small model, with no conversation", () => {
    const s = useGraphStore.getState();
    expect(s.aiOpen).toBe(false);
    expect(s.aiTurns).toEqual([]);
    expect(s.aiModel).toBe("qwen2.5-coder-0.5b");
  });

  it("the toolbar can open and the panel can close", () => {
    useGraphStore.getState().setAiOpen(true);
    expect(useGraphStore.getState().aiOpen).toBe(true);
    useGraphStore.getState().setAiOpen(false);
    expect(useGraphStore.getState().aiOpen).toBe(false);
  });

  it("runs the model and lands the answer as a done turn", async () => {
    const run = useGraphStore.getState().aiGenerate("make the checkout clearer");
    const fresh = useGraphStore.getState();
    expect(fresh.aiTurns).toHaveLength(1);
    // (The first tokens arrive within the same tick, so the code is not
    // necessarily empty here — but the bubble is still in progress.)
    expect(fresh.aiTurns[0]).toMatchObject({
      request: "make the checkout clearer",
      state: "working",
      attempts: 1,
    });
    await run;
    const s = useGraphStore.getState();
    expect(s.aiTurns).toHaveLength(1);
    expect(s.aiTurns[0].state).toBe("done");
    expect(s.aiTurns[0].code.startsWith("flowchart TD")).toBe(true);
    expect(s.aiTurns[0].error).toBeNull();
    expect(s.aiTurns[0].attempts).toBe(1);
  });

  it("does not show the model the positions comment", async () => {
    // A line of JSON coordinates is nothing the model can use, and a small
    // one shown it recites it back until it runs out of tokens.
    await useGraphStore
      .getState()
      .applyCode(START + '%% graph:positions {"a":{"x":0,"y":0},"b":{"x":0,"y":120}}\n');
    expect(useGraphStore.getState().code).toContain("%% graph:positions");
    const generate = vi.spyOn(fakeProvider, "generate");
    await useGraphStore.getState().aiGenerate("make the checkout clearer");
    const prompt = generate.mock.calls[0][0].map((m) => m.content).join("\n");
    expect(prompt).toContain("a[Start] --> b[Done]");
    expect(prompt).not.toContain("graph:positions");
  });

  it("a conversation threads its turns: each answer joins the thread", async () => {
    await useGraphStore.getState().aiGenerate("make the checkout clearer");
    await useGraphStore.getState().aiGenerate("a sign-in flow as a sequence diagram");
    const turns = useGraphStore.getState().aiTurns;
    expect(turns).toHaveLength(2);
    expect(turns[0].request).toBe("make the checkout clearer");
    expect(turns[0].code.startsWith("flowchart TD")).toBe(true);
    expect(turns[1].state).toBe("done");
    expect(turns[1].code.startsWith("sequenceDiagram")).toBe(true);
    expect(turns.map((t) => t.id)).toEqual([...new Set(turns.map((t) => t.id))]);
  });

  it("a follow-up actually changes the drawing, instead of redrawing it for nothing", async () => {
    await useGraphStore.getState().aiGenerate("make the checkout clearer");
    const first = useGraphStore.getState().aiTurns[0].code;
    await useGraphStore.getState().aiGenerate("colour it blue");
    const coloured = useGraphStore.getState().aiTurns[1].code;
    expect(coloured).toContain("style a fill:#3b82f6");
    expect(coloured).not.toBe(first);
    await useGraphStore.getState().aiGenerate("add another step");
    const grown = useGraphStore.getState().aiTurns[2].code;
    expect(grown).toContain('--> x1["More"]');
    expect(grown).not.toBe(coloured);
    // Each turn edits the document on screen — and the document on screen is
    // now whatever the turn before it left there.
    expect(useGraphStore.getState().code).toBe(grown);
  });

  it("retries a broken first draw and still lands", async () => {
    await useGraphStore.getState().aiGenerate("fail once, then get it right");
    const turn = useGraphStore.getState().aiTurns[0];
    expect(turn.state).toBe("done");
    expect(turn.code.startsWith("flowchart TD")).toBe(true);
    expect(turn.attempts).toBe(2);
  });

  it("reports a persistent bad draw and shows the refused code", async () => {
    await useGraphStore.getState().aiGenerate("never parses, always answer broken");
    const turn = useGraphStore.getState().aiTurns[0];
    expect(turn.state).toBe("error");
    expect(turn.error).toBeTruthy();
    expect(turn.attempts).toBe(3);
    // The last draw is shown back, so the failure is not opaque.
    expect(turn.code).toContain("--> -->");
  });

  it("an answer lands on the canvas by itself, as one undoable step", async () => {
    const before = useGraphStore.getState().code;
    await useGraphStore.getState().aiGenerate("make the checkout clearer");
    const turn = useGraphStore.getState().aiTurns[0];
    const s = useGraphStore.getState();
    // Nothing was pressed: a turn is an instruction to change the drawing.
    expect(s.code).toBe(turn.code);
    expect(s.code).not.toBe(before);
    expect(turn.codeBefore).toBe(before);
    // Ordinary undo still covers the whole replacement.
    await s.undo();
    expect(useGraphStore.getState().code).toBe(before);
  });

  it("asks the canvas to fit the drawing it just replaced", async () => {
    const before = useGraphStore.getState().fitSeq;
    await useGraphStore.getState().aiGenerate("make the checkout clearer");
    expect(useGraphStore.getState().fitSeq).toBeGreaterThan(before);
  });

  it("a failed follow-up leaves the answer that did land in place", async () => {
    await useGraphStore.getState().aiGenerate("make the checkout clearer");
    const first = useGraphStore.getState().aiTurns[0];
    await useGraphStore.getState().aiGenerate("never parses, always answer broken");
    expect(useGraphStore.getState().code).toBe(first.code);
  });

  it("a turn that never drew leaves the document alone", async () => {
    const before = useGraphStore.getState().code;
    await useGraphStore.getState().aiGenerate("never parses, always answer broken");
    const turn = useGraphStore.getState().aiTurns[0];
    expect(turn.state).toBe("error");
    // Nothing reached the canvas, so there is nothing to offer a way back to.
    expect(turn.codeBefore).toBeNull();
    expect(useGraphStore.getState().code).toBe(before);
  });

  it("one turn can be taken back on its own, and only once", async () => {
    const before = useGraphStore.getState().code;
    await useGraphStore.getState().aiGenerate("make the checkout clearer");
    const turn = useGraphStore.getState().aiTurns[0];
    useGraphStore.getState().aiUndoTurn(turn.id);
    await waitFor(() => useGraphStore.getState().code === before);
    // The offer is spent: undoing twice would restore a document that is no
    // longer the one this turn came before.
    expect(useGraphStore.getState().aiTurns[0].codeBefore).toBeNull();
  });

  it("undoing an unknown turn does nothing", () => {
    useGraphStore.getState().aiUndoTurn("ai-999");
    expect(useGraphStore.getState().code).toBe(START);
  });

  it("New conversation wipes the thread and leaves the document alone", async () => {
    await useGraphStore.getState().aiGenerate("make the checkout clearer");
    // The answer is already on the canvas, and forgetting the conversation is
    // no reason to take the drawing back off whoever asked for it.
    const drawn = useGraphStore.getState().code;
    expect(drawn).not.toBe(START);
    useGraphStore.getState().aiClear();
    expect(useGraphStore.getState().aiTurns).toEqual([]);
    expect(useGraphStore.getState().code).toBe(drawn);
  });

  it("Cancel stops a run without touching the document, and the half-drawn turn never lands", async () => {
    useGraphStore.getState().aiGenerate("never parses, always answer broken");
    useGraphStore.getState().aiCancel();
    await waitFor(() => useGraphStore.getState().aiTurns.length === 0);
    const s = useGraphStore.getState();
    expect(s.aiTurns).toEqual([]);
    expect(s.code).toBe(START);
  });

  it("a new generation cuts the running one off", async () => {
    const a = useGraphStore.getState().aiGenerate("never parses, always answer broken");
    await new Promise((r) => setTimeout(r, 5));
    const b = useGraphStore.getState().aiGenerate("a sign-in flow as a sequence diagram");
    await b;
    const turns = useGraphStore.getState().aiTurns;
    expect(turns).toHaveLength(1);
    expect(turns[0].code.startsWith("sequenceDiagram")).toBe(true);
    await a;
    // The cancelled run did not clobber the finished one afterwards.
    const lasts = useGraphStore.getState().aiTurns;
    expect(lasts).toHaveLength(1);
    expect(lasts[0].code.startsWith("sequenceDiagram")).toBe(true);
  });

  it("remembers the chosen model for the next run", async () => {
    useGraphStore.getState().setAiModel("qwen2.5-coder-1.5b");
    expect(useGraphStore.getState().aiModel).toBe("qwen2.5-coder-1.5b");
    await useGraphStore.getState().aiGenerate("make the checkout clearer");
    expect(useGraphStore.getState().aiTurns[0].state).toBe("done");
  });

  it("each document keeps its own conversation", async () => {
    await useGraphStore.getState().aiGenerate("make the checkout clearer");
    expect(useGraphStore.getState().aiTurns).toHaveLength(1);
    // A second document comes on screen through swapHistory, the one hook
    // every switch goes through.
    useGraphStore.getState().swapHistory("doc-a", "doc-b");
    expect(useGraphStore.getState().aiTurns).toEqual([]);
    expect(useGraphStore.getState().aiDocId).toBe("doc-b");
    await useGraphStore.getState().aiGenerate("a sign-in flow as a sequence diagram");
    expect(useGraphStore.getState().aiTurns).toHaveLength(1);
    // And back: the first document's thread is gone with it.
    useGraphStore.getState().swapHistory("doc-b", "doc-a");
    expect(useGraphStore.getState().aiTurns).toEqual([]);
  });

  it("switching to the document already here keeps the thread", async () => {
    useGraphStore.getState().swapHistory("", "doc-a");
    await useGraphStore.getState().aiGenerate("make the checkout clearer");
    expect(useGraphStore.getState().aiTurns).toHaveLength(1);
    useGraphStore.getState().swapHistory("doc-a", "doc-a");
    expect(useGraphStore.getState().aiTurns).toHaveLength(1);
  });
});
