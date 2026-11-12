import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useGraphStore } from "../store";
import type { AnyNode } from "../model/types";
import { Inspector } from "./Inspector";

afterEach(cleanup);

const shapeNode = {
  id: "a",
  type: "shape",
  position: { x: 0, y: 0 },
  data: { label: "Start", shape: "square", direction: "TB" },
  selected: true,
} as unknown as AnyNode;

beforeEach(() => {
  useGraphStore.setState({
    kind: "flowchart",
    nodes: [shapeNode],
    edges: [],
    code: 'flowchart TD\n  a["Start"]\n',
  });
});

/**
 * The label field is controlled and re-renders from the store on every
 * keystroke. A conversion that trimmed each line took the space between two
 * words before the next character was typed, so "I went home" came out as
 * "Iwenthome". Both the node field and the edge field are checked: the node
 * one is a textarea, the edge one an input, and only the textarea went
 * through the lossy conversion.
 */
describe("the inspector's label field", () => {
  it("keeps the spaces between words in a node label", async () => {
    render(<Inspector />);
    const field = document.getElementById("inspector-label") as HTMLTextAreaElement;
    const user = userEvent.setup();
    await user.clear(field);
    await user.type(field, "I went home");
    expect(useGraphStore.getState().nodes[0].data.label).toBe("I went home");
  });

  it("keeps the spaces between words in an edge label", async () => {
    useGraphStore.setState({
      nodes: [],
      edges: [
        {
          id: "e1",
          source: "a",
          target: "b",
          data: { label: "", stroke: "normal", arrow: "arrow_point" },
          selected: true,
        },
      ],
      code: "flowchart TD\n  a --> b\n",
    });
    render(<Inspector />);
    const field = document.getElementById("inspector-label") as HTMLInputElement;
    const user = userEvent.setup();
    await user.click(field);
    await user.keyboard("I went home");
    expect(useGraphStore.getState().edges[0].data?.label).toBe("I went home");
  });
});
