import { describe, expect, it } from "vitest";
import { fakeProvider, fakeCodeFor } from "./fake";
import { EXAMPLE_FEEDBACK, UNCHANGED_FEEDBACK } from "./prompt";
import {
  AiNotConfiguredError,
  DiagramGenerationError,
  MAX_ATTEMPTS,
  echoesExample,
  generateDiagram,
} from "./generate";
import type { AiProvider, AiRequest } from "./types";

const REQUEST: AiRequest = {
  kind: "flowchart",
  code: "flowchart TD\n  a --> b",
  request: "split the payment step",
  model: "qwen2.5-coder-0.5b",
};

/** A provider that answers from the prompt, useful for scripting failures. */
const responding = (answer: string | ((turn: string) => string)): AiProvider => ({
  kind: "test",
  available: () => true,
  async generate(chat) {
    const turn = chat[chat.length - 1]?.content ?? "";
    return typeof answer === "function" ? answer(turn) : answer;
  },
});

describe("generateDiagram", () => {
  it("accepts a valid answer on the first draw", async () => {
    const onAttempt: number[] = [];
    const result = await generateDiagram(REQUEST, responding(fakeCodeFor("make it clearer")), {
      onAttempt: (n) => onAttempt.push(n),
    });
    expect(result.code.startsWith("flowchart TD")).toBe(true);
    expect(result.attempts).toBe(1);
    expect(onAttempt).toEqual([1]);
  });

  it("streams the answer as it comes", async () => {
    const tokens: string[] = [];
    const result = await generateDiagram(REQUEST, fakeProvider, {
      onToken: (t) => tokens.push(t),
    });
    // The answer lands trimmed; the stream's last token is the untrimmed draw.
    expect(tokens.at(-1)?.trim()).toBe(result.code);
    // Each token is the text so far — a running draw, not a burst of pieces.
    let growing = true;
    for (let i = 1; i < tokens.length; i++) {
      if (
        !result.code.startsWith(tokens[i].trim()) ||
        tokens[i].length <= tokens[i - 1].length
      ) {
        growing = false;
      }
    }
    expect(growing).toBe(true);
  });

  it("retries once when the first draw is broken, then accepts", async () => {
    const attempts: number[] = [];
    const provider = responding((turn) =>
      turn.includes("did not parse") ? fakeCodeFor(turn) : "flowchart TD\n  a --> --> b",
    );
    const result = await generateDiagram(REQUEST, provider, {
      onAttempt: (n) => attempts.push(n),
    });
    expect(result.code.startsWith("flowchart TD")).toBe(true);
    expect(result.attempts).toBe(2);
    expect(attempts).toEqual([1, 2]);
  });

  it("retries an answer that echoes the document, telling it so", async () => {
    const attempts: number[] = [];
    const turns: string[] = [];
    const provider = responding((turn) => {
      turns.push(turn);
      return turn.includes(UNCHANGED_FEEDBACK)
        ? "flowchart TD\n  a --> b\n  c --> d"
        : REQUEST.code;
    });
    const result = await generateDiagram(REQUEST, provider, {
      onAttempt: (n) => attempts.push(n),
    });
    expect(result.attempts).toBe(2);
    expect(attempts).toEqual([1, 2]);
    // The second turn asked it to actually change the drawing, not retry the draw.
    expect(turns[1]).toContain(UNCHANGED_FEEDBACK);
    expect(turns[1]).not.toContain("did not parse");
  });

  it("gives up after repeated no-op answers, like it does for bad ones", async () => {
    const provider = responding(REQUEST.code);
    const err = await generateDiagram(REQUEST, provider).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DiagramGenerationError);
    const shown = err as DiagramGenerationError;
    expect(shown.attempts).toBe(MAX_ATTEMPTS);
    expect(shown.message).toMatch(/never changed/);
    expect(shown.code).toBe(REQUEST.code);
  });

  it("gives up after the last retry and hands back the refused draw", async () => {
    const broken = "flowchart TD\n  a --> --> b";
    const provider = responding(broken);
    const err = await generateDiagram(REQUEST, provider).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DiagramGenerationError);
    const shown = err as DiagramGenerationError;
    expect(shown.attempts).toBe(MAX_ATTEMPTS);
    expect(shown.code).toBe(broken);
  });

  it("wrangles ```mermaid fences off a well-mannered answer", async () => {
    const fenced =
      "```mermaid\nflowchart TD\n  a --> b\n  c --> d\n```\nprose that is not the diagram";
    const result = await generateDiagram(REQUEST, responding(fenced));
    expect(result.code).toBe("flowchart TD\n  a --> b\n  c --> d");
    expect(result.attempts).toBe(1);
  });

  it("refuses an answer that edited the worked example, and says so on the retry", async () => {
    const seq: AiRequest = {
      ...REQUEST,
      kind: "sequence",
      code: "sequenceDiagram\n  participant U as User\n  participant S as Server\n  U->>S: POST /login",
    };
    const turns: string[] = [];
    const result = await generateDiagram(
      seq,
      responding((turn) => {
        turns.push(turn);
        return turns.length === 1
          ? "sequenceDiagram\n  participant K as Kitchen\n  K->>K: order a pizza"
          : `${seq.code}\n  S-->>U: 200 OK`;
      }),
    );
    expect(result.attempts).toBe(2);
    expect(turns[1]).toContain(EXAMPLE_FEEDBACK);
  });

  it("does not hold the example's names against someone who uses them", () => {
    const kitchen: AiRequest = {
      ...REQUEST,
      kind: "sequence",
      code: "sequenceDiagram\n  participant W as Waiter\n  participant K as Kitchen",
      request: "the kitchen confirms",
    };
    expect(echoesExample(`${kitchen.code}\n  K-->>W: confirmed`, kitchen)).toBe(false);
    expect(echoesExample(`${kitchen.code}\n  K-->>W: pizza ready`, kitchen)).toBe(true);
  });

  it("drops what stands above the header, like the 3B model's stray `mer`", async () => {
    const result = await generateDiagram(
      REQUEST,
      responding("mer\nflowchart TD\n  a --> b\n  c --> d"),
    );
    expect(result.code).toBe("flowchart TD\n  a --> b\n  c --> d");
    expect(result.attempts).toBe(1);
  });

  it("leaves an answer with no header at all for the parser to refuse", async () => {
    const run = generateDiagram(REQUEST, responding("mer\n  a --> b"));
    await expect(run).rejects.toBeInstanceOf(DiagramGenerationError);
  });

  it("refuses to run when the provider has no model behind it", async () => {
    const bare: AiProvider = {
      kind: "test",
      available: () => false,
      generate: async () => "",
    };
    await expect(generateDiagram(REQUEST, bare)).rejects.toBeInstanceOf(AiNotConfiguredError);
  });

  it("cancels a run mid-stream with an AbortError", async () => {
    const ctrl = new AbortController();
    const run = generateDiagram(REQUEST, fakeProvider, { signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 5);
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
  });
});
