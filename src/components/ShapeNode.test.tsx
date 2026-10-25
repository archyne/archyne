import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import type { NodeProps } from "@xyflow/react";
import type { GroupNode, ShapeNode } from "../model/types";

// The node draws from React Flow's store; outside a flow there is none, so the
// three things it asks of it are stood in for.
vi.mock("@xyflow/react", async (actual) => ({
  ...(await actual<typeof import("@xyflow/react")>()),
  useInternalNode: () => ({ style: { width: 160, height: 54 } }),
  Handle: () => null,
  NodeResizer: () => null,
}));

const { GroupNodeView, ShapeNodeView } = await import("./ShapeNode");

function node(styles?: string[]) {
  const props = {
    id: "a",
    data: {
      label: "Primo nodo",
      shape: "square",
      direction: "TB",
      ...(styles ? { styles } : {}),
    },
    selected: false,
  } as unknown as NodeProps<ShapeNode>;
  const view = render(<ShapeNodeView {...props} />);
  fireEvent.doubleClick(view.container.querySelector(".shape-node")!);
  return view.container;
}

/**
 * Typing a node's name in place: the field has to look like the words it
 * stands in for, or there is no telling what they will look like once done.
 */
describe("a container's own colours", () => {
  const group = (styles?: string[]) => {
    const props = {
      id: "g",
      data: { label: "VNet", subgraphId: "g", ...(styles ? { styles } : {}) },
      selected: false,
    } as unknown as NodeProps<GroupNode>;
    return render(<GroupNodeView {...props} />).container.querySelector(
      ".group-node",
    ) as HTMLElement;
  };

  it("paints its frame and its title with them, in a solid line", () => {
    const frame = group(["fill:#dae8fc", "stroke:#6c8ebf", "color:#111111"]);
    expect(frame.style.getPropertyValue("--group-fill")).toBe("#dae8fc");
    expect(frame.style.getPropertyValue("--group-stroke")).toBe("#6c8ebf");
    expect(frame.style.getPropertyValue("--group-text")).toBe("#111111");
    expect(frame.classList.contains("painted")).toBe(true);
  });

  it("keeps the dash when it was given one", () => {
    const frame = group(["fill:#f5f5f5", "stroke-dasharray:5 5"]);
    expect(frame.classList.contains("painted")).toBe(false);
  });

  it("leaves one with none to the theme", () => {
    const frame = group();
    expect(frame.style.getPropertyValue("--group-fill")).toBe("");
    expect(frame.classList.contains("painted")).toBe(false);
  });
});

describe("renaming a shape on the canvas", () => {
  it("puts the field inside the label, where it takes the label's type", () => {
    // Beside the label it came up in the browser's own sixteen pixels.
    const field = node().querySelector("textarea.node-rename")!;
    expect(field.closest(".shape-label")).not.toBeNull();
  });

  it("paints the field with the node's own fill", () => {
    // A pale imported box carries dark text; on the canvas's dark background
    // the field showed it black on black.
    const field = node(["fill:#d5e8d4", "color:#111111"]).querySelector(
      "textarea.node-rename",
    )!;
    const slot = field.closest(".node-rename-slot") as HTMLElement;
    expect(slot.style.getPropertyValue("--rename-bg")).toBe("#d5e8d4");
  });

  it("leaves a node with no fill of its own to the theme", () => {
    const field = node().querySelector("textarea.node-rename")!;
    const slot = field.closest(".node-rename-slot") as HTMLElement;
    expect(slot.style.getPropertyValue("--rename-bg")).toBe("");
  });
});
