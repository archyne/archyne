import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { en } from "../i18n/en";
import { useGraphStore } from "../store";
import type { AnyNode } from "../model/types";
import { GraphOutline } from "./GraphOutline";

afterEach(cleanup);

/**
 * The outline selects as the canvas does: a plain click picks one node,
 * Ctrl adds or removes, Shift takes a run of rows.
 */

const node = (id: string): AnyNode =>
  ({
    id,
    type: "shape",
    position: { x: 0, y: 0 },
    data: { label: id.toUpperCase(), shape: "rect" },
  }) as unknown as AnyNode;

const selected = () =>
  useGraphStore
    .getState()
    .nodes.filter((n) => n.selected)
    .map((n) => n.id);

const row = (id: string) =>
  screen.getByRole("button", {
    name: en["outline.select"].replace("{name}", id.toUpperCase()),
  });

beforeEach(() => {
  useGraphStore.setState({
    kind: "flowchart",
    nodes: ["a", "b", "c", "d", "e"].map(node),
    edges: [],
    code: "flowchart TD\n",
  });
});

describe("selecting in the outline", () => {
  it("picks one node with a plain click", async () => {
    render(<GraphOutline />);
    const user = userEvent.setup();
    await user.click(row("a"));
    await user.click(row("c"));
    expect(selected()).toEqual(["c"]);
  });

  it("adds and removes with Ctrl", async () => {
    render(<GraphOutline />);
    const user = userEvent.setup();
    await user.click(row("a"));
    await user.keyboard("{Control>}");
    await user.click(row("c"));
    await user.click(row("e"));
    expect(selected()).toEqual(["a", "c", "e"]);
    await user.click(row("c"));
    await user.keyboard("{/Control}");
    expect(selected()).toEqual(["a", "e"]);
  });

  it("takes the run from the last row clicked with Shift", async () => {
    render(<GraphOutline />);
    const user = userEvent.setup();
    await user.click(row("b"));
    await user.keyboard("{Shift>}");
    await user.click(row("d"));
    expect(selected()).toEqual(["b", "c", "d"]);
    // From the same anchor the other way: the run replaces, it does not grow.
    await user.click(row("a"));
    await user.keyboard("{/Shift}");
    expect(selected()).toEqual(["a", "b"]);
  });

  it("adds a run to what is selected with Ctrl+Shift", async () => {
    render(<GraphOutline />);
    const user = userEvent.setup();
    await user.click(row("a"));
    await user.keyboard("{Control>}");
    await user.click(row("c"));
    await user.keyboard("{Shift>}");
    await user.click(row("e"));
    await user.keyboard("{/Shift}{/Control}");
    expect(selected()).toEqual(["a", "c", "d", "e"]);
  });

  it("runs over the rows as filtered, not the ones hidden", async () => {
    useGraphStore.setState({ nodes: ["x1", "y", "x2", "x3"].map(node) });
    render(<GraphOutline />);
    const user = userEvent.setup();
    await user.type(screen.getByRole("searchbox"), "x");
    await user.click(row("x1"));
    await user.keyboard("{Shift>}");
    await user.click(row("x3"));
    await user.keyboard("{/Shift}");
    expect(selected()).toEqual(["x1", "x2", "x3"]);
  });
});
