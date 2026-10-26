import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { en } from "../i18n/en";
import { useGraphStore } from "../store";
import type { AnyNode } from "../model/types";
import { Inspector } from "./Inspector";
import { CommandPalette } from "./CommandPalette";

afterEach(cleanup);

/**
 * Colouring a selection: the same controls as for one node, applied to all
 * of it, and honest about where the nodes disagree.
 */

function shape(id: string, styles: string[], extra: Partial<AnyNode> = {}): AnyNode {
  return {
    id,
    type: "shape",
    position: { x: 0, y: 0 },
    selected: true,
    data: { label: id, shape: "rect", styles },
    ...extra,
  } as unknown as AnyNode;
}

const stylesOf = (id: string) =>
  (useGraphStore.getState().nodes.find((n) => n.id === id)!.data as { styles?: string[] })
    .styles;

beforeEach(() => {
  useGraphStore.setState({ kind: "flowchart", edges: [], code: "flowchart TD\n" });
});

describe("colouring a selection", () => {
  it("stripes a colour the nodes do not share, and not one they do", () => {
    useGraphStore.setState({
      nodes: [
        shape("a", ["fill:#dae8fc", "stroke:#6c8ebf"]),
        shape("b", ["fill:#f8cecc", "stroke:#6c8ebf"]),
      ],
    });
    const { container } = render(<Inspector />);
    const fill = container.querySelector<HTMLInputElement>('input[type="color"]')!;
    expect(fill.classList.contains("mixed")).toBe(true);
    // The border is the same on both, so it is shown as it is.
    const mixed = container.querySelectorAll('input[type="color"].mixed');
    expect(mixed).toHaveLength(1);
  });

  it("applies a preset to every node in one step of undo", async () => {
    useGraphStore.setState({ nodes: [shape("a", []), shape("b", ["fill:#000000"])] });
    const before = useGraphStore.getState().canUndo;
    render(<Inspector />);
    await userEvent.setup().click(
      screen.getByRole("button", {
        name: en["insp.preset"].replace("{fill}", "#d5e8d4").replace("{stroke}", "#82b366"),
      }),
    );
    for (const id of ["a", "b"]) {
      expect(stylesOf(id)).toEqual(expect.arrayContaining(["fill:#d5e8d4", "stroke:#82b366"]));
    }
    expect(before).toBe(false);
    expect(useGraphStore.getState().canUndo).toBe(true);
    await useGraphStore.getState().undo();
    expect(useGraphStore.getState().canUndo).toBe(false);
  });

  it("says which nodes a colour cannot reach", () => {
    useGraphStore.setState({
      kind: "architecture",
      nodes: [
        shape("a", []),
        {
          id: "s",
          type: "service",
          position: { x: 0, y: 0 },
          selected: true,
          data: { label: "s", icon: "server" },
        } as unknown as AnyNode,
      ],
    });
    render(<Inspector />);
    expect(
      screen.getByText(en["insp.styleSome"].replace("{count}", "1").replace("{total}", "2")),
    ).toBeTruthy();
  });

  it("offers no colours where nothing selected can take them", () => {
    useGraphStore.setState({
      kind: "architecture",
      nodes: ["s", "t"].map(
        (id) =>
          ({
            id,
            type: "service",
            position: { x: 0, y: 0 },
            selected: true,
            data: { label: id, icon: "server" },
          }) as unknown as AnyNode,
      ),
    });
    render(<Inspector />);
    expect(screen.queryByRole("group", { name: en["insp.presets"] })).toBeNull();
  });
});

describe("the selection's commands in the palette", () => {
  // jsdom has no layout, so no scrolling; the palette keeps its active row
  // in view with this.
  beforeAll(() => {
    Element.prototype.scrollIntoView ??= () => {};
  });

  function sized(id: string, x: number, w: number): AnyNode {
    return shape(id, [], { position: { x, y: 0 }, style: { width: w, height: 40 } });
  }

  it("lists same width, same height and group when they can act", () => {
    useGraphStore.setState({ nodes: [sized("a", 0, 100), sized("b", 200, 160)] });
    render(<CommandPalette onClose={() => {}} />);
    for (const name of [
      en["insp.matchWidth"],
      en["insp.matchHeight"],
      en["menu.groupNodes"].replace("{count}", "2"),
    ]) {
      expect(screen.getByRole("option", { name })).toBeTruthy();
    }
  });

  it("runs them on the selection", async () => {
    useGraphStore.setState({ nodes: [sized("a", 0, 100), sized("b", 200, 160)] });
    render(<CommandPalette onClose={() => {}} />);
    await userEvent.setup().click(screen.getByRole("option", { name: en["insp.matchWidth"] }));
    const widths = useGraphStore.getState().nodes.map((n) => n.style?.width);
    expect(widths).toEqual([160, 160]);
  });

  it("leaves out sizing with nothing to size against", () => {
    // Grouping one node stays on offer: wrapping a single box is a fair
    // thing to want. Matching its size to itself is not.
    useGraphStore.setState({ nodes: [sized("a", 0, 100)] });
    render(<CommandPalette onClose={() => {}} />);
    expect(screen.queryByRole("option", { name: en["insp.matchWidth"] })).toBeNull();
    expect(screen.queryByRole("option", { name: en["insp.matchHeight"] })).toBeNull();
  });
});
