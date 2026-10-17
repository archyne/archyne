import { describe, expect, it } from "vitest";
import { fakeCodeFor } from "./fake";
import { parseDiagram } from "../model/diagram";
import type { DiagramKind } from "../model/types";
import { EDIT_LABEL, EXAMPLES, buildChat, RETRY_FEEDBACK } from "./prompt";
import type { AiRequest } from "./types";

const REQUEST: AiRequest = {
  kind: "flowchart",
  code: "flowchart TD\n  a --> b",
  request: "add a step before b",
  model: "qwen2.5-coder-0.5b",
};

describe("buildChat", () => {
  it("tells the model the family, the document and the request, last", () => {
    const chat = buildChat(REQUEST);
    expect(chat.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    const user = chat[3].content;
    expect(user).toContain("flowchart");
    expect(user).toContain(REQUEST.code);
    expect(user).toContain("add a step before b");
    expect(user).not.toContain("did not parse");
  });

  it("says plainly when the document is empty rather than printing nothing", () => {
    const chat = buildChat({ ...REQUEST, code: "   " });
    expect(chat[3].content).toContain("(the diagram is empty)");
  });

  it("tacks the retry feedback onto the real turn, not the example", () => {
    const feedback = RETRY_FEEDBACK({ kind: "flowchart", error: "syntax error in a" });
    const chat = buildChat(REQUEST, feedback);
    const user = chat[3].content;
    expect(user).toContain("syntax error in a");
    // The stub provider keys on exactly this phrase (see fake.ts).
    expect(user).toContain("did not parse");
    expect(chat[1].content).not.toContain("did not parse");
  });

  it("keeps the brief short so a small model can follow it", () => {
    // ~250 words or fewer, or a model of this size gets the gist or none.
    expect(buildChat(REQUEST)[0].content.split(/\s+/).length).toBeLessThan(250);
  });

  it("works the open document's own family as the example exchange", () => {
    for (const kind of Object.keys(EXAMPLES) as DiagramKind[]) {
      const chat = buildChat({ ...REQUEST, kind });
      expect(chat[1].content).toContain(`a ${kind}.`);
      expect(chat[1].content).toContain(EXAMPLES[kind].document);
      expect(chat[1].content).toContain(`${EDIT_LABEL}\n${EXAMPLES[kind].request}`);
      expect(chat[2].content).toBe(EXAMPLES[kind].answer);
    }
  });
});

describe("the examples", () => {
  // An example is copied, forms and all. One that does not parse — or that
  // parses as another family — would teach the mistake it exists to prevent.
  for (const [kind, example] of Object.entries(EXAMPLES)) {
    it(`the ${kind} exchange parses as a ${kind} on both sides, and changes something`, async () => {
      const before = await parseDiagram(example.document);
      const after = await parseDiagram(example.answer);
      expect(before.kind).toBe(kind);
      expect(after.kind).toBe(kind);
      // A sequence exchange adds messages rather than participants, so the
      // count may hold still; the text may not.
      expect(after.nodes.length).toBeGreaterThanOrEqual(before.nodes.length);
      expect(example.answer).not.toBe(example.document);
    });
  }

  it("each names marks that really are its own", () => {
    for (const example of Object.values(EXAMPLES)) {
      expect(example.marks.length).toBeGreaterThan(0);
      for (const mark of example.marks) {
        expect(`${example.document}\n${example.answer}`.toLowerCase()).toContain(
          mark.toLowerCase(),
        );
      }
    }
  });

  it("each shows the colour or icon form its family can carry", () => {
    expect(EXAMPLES.flowchart.answer).toMatch(/^\s*style \w+ fill:/m);
    expect(EXAMPLES.flowchart.answer).toMatch(/@\{ icon: "/);
    expect(EXAMPLES.state.answer).toMatch(/^\s*classDef \w+ fill:/m);
    expect(EXAMPLES.state.answer).toMatch(/^\s*class \w+ \w+$/m);
    expect(EXAMPLES.class.answer).toMatch(/^\s*style \w+ fill:/m);
    expect(EXAMPLES.er.answer).toMatch(/\|\|--o\{/);
  });
});

describe("fakeCodeFor", () => {
  it("answers a flowchart request", () => {
    expect(fakeCodeFor("make the checkout clearer").startsWith("flowchart TD")).toBe(true);
  });

  it("answers a sequence request with a sequence diagram", () => {
    expect(
      fakeCodeFor("a sign-in flow as a sequence diagram").startsWith("sequenceDiagram"),
    ).toBe(true);
  });

  it("answers an ER request with an ER diagram", () => {
    expect(fakeCodeFor("the orders schema as an er diagram").startsWith("erDiagram")).toBe(
      true,
    );
  });

  it("answers a retry with valid code", () => {
    const feedback = RETRY_FEEDBACK({ kind: "flowchart", error: "gone wrong" });
    expect(fakeCodeFor(feedback).startsWith("flowchart TD")).toBe(true);
  });

  it("makes a 'never parses' request fail forever", () => {
    expect(fakeCodeFor("never parses anything and always answers broken")).toContain("--> -->");
  });
});

describe("fakeCodeFor edits", () => {
  const turn = (request: string, code: string): string =>
    buildChat({ kind: "flowchart", code, request, model: "qwen2.5-coder-0.5b" }).at(-1)!
      .content;
  const DOC = "flowchart TD\n  a[Start] --> b[Done]\n";

  it("grows the open drawing when asked to add a step", () => {
    const out = fakeCodeFor(turn("add another step", DOC));
    expect(out).toContain('x1["More"]');
    // Header, node ids and colour lines all survive the edit.
    expect(out.startsWith("flowchart TD")).toBe(true);
    expect(out).toContain("a[Start]");
    expect(out).not.toBe(DOC);
  });

  it("colours a node when asked", () => {
    const out = fakeCodeFor(turn("colour it blue", DOC));
    expect(out).toContain("style a fill:#3b82f6");
    expect(out).toContain("a[Start]");
  });

  it("turns a node into an icon composition when asked", () => {
    const out = fakeCodeFor(turn("give it an icon", DOC));
    expect(out).toContain('a@{ icon: "logos:layer"');
  });

  it("removes the last step when asked", () => {
    const doc = "flowchart TD\n  a[Start] --> b[Done]\n  b --> c[End]\n";
    const out = fakeCodeFor(turn("remove the last step", doc));
    expect(out).not.toContain("c[End]");
    expect(out).toBe("flowchart TD\n  a[Start] --> b[Done]");
  });

  it("renames a node when asked", () => {
    const out = fakeCodeFor(turn("rename it to Checkout", DOC));
    expect(out).toContain('a["Checkout"]');
  });

  it("even a vague follow-up changes the drawing rather than echoing it", () => {
    const out = fakeCodeFor(turn("make it clearer", DOC));
    expect(out).not.toBe(DOC);
    expect(out.startsWith("flowchart TD")).toBe(true);
  });

  it("reads the request out of the envelope, not the whole turn", () => {
    // The marker is the one split point: everything letter-for-letter that a
    // future real provider would parse from the same message.
    expect(turn("add another step", DOC).includes(EDIT_LABEL)).toBe(true);
    expect(fakeCodeFor(turn("add another step", DOC)).split("\n").length).toBe(
      DOC.split("\n").length + 1,
    );
  });
});
