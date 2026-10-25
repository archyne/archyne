import { beforeEach, describe, expect, it } from "vitest";
import { useGraphStore } from "./store";

const FLOWCHART = 'flowchart TD\n  a["One"] --> b["Two"]\n';
const GANTT = `gantt
  title Rollout
  dateFormat YYYY-MM-DD
  section Phase 1
  Design :a1, 2026-01-01, 30d
`;

async function load(code: string) {
  await useGraphStore.getState().applyCode(code);
}

beforeEach(() => {
  useGraphStore.setState({ unsupported: null, parseError: null, warning: null });
});

describe("unsupported diagram families", () => {
  it("opens a gantt file read-only instead of failing", async () => {
    await load(GANTT);
    const s = useGraphStore.getState();
    expect(s.unsupported).toBe("gantt");
    // It is not an error: the file is valid, we just cannot edit it visually.
    expect(s.parseError).toBeNull();
    expect(s.code).toBe(GANTT);
  });

  it("drops the previous graph so the canvas cannot be edited into it", async () => {
    await load(FLOWCHART);
    expect(useGraphStore.getState().nodes.length).toBe(2);

    await load(GANTT);
    expect(useGraphStore.getState().nodes).toEqual([]);
    expect(useGraphStore.getState().edges).toEqual([]);
  });

  it("never rewrites the code while read-only", async () => {
    await load(GANTT);
    // setDiagramMeta re-serializes from the parsed graph. With no graph
    // behind it that would replace the gantt with an empty flowchart.
    useGraphStore.getState().setDiagramMeta({ accTitle: "Anything" });
    expect(useGraphStore.getState().code).toBe(GANTT);

    useGraphStore.getState().setDirection("LR");
    expect(useGraphStore.getState().code).toBe(GANTT);
  });

  it("clears the flag when an editable diagram is loaded again", async () => {
    await load(GANTT);
    expect(useGraphStore.getState().unsupported).toBe("gantt");

    await load(FLOWCHART);
    const s = useGraphStore.getState();
    expect(s.unsupported).toBeNull();
    expect(s.nodes.length).toBe(2);
  });

  it("still reports genuinely broken code as a parse error", async () => {
    await load("flowchart TD\n  a --> --> b\n");
    const s = useGraphStore.getState();
    expect(s.parseError).toBeTruthy();
    expect(s.unsupported).toBeNull();
  });
});

describe("code that does not parse", () => {
  const BROKEN = "flowchart TD\n  a --> --> b\n";

  it("keeps the last good picture while the code is being typed", async () => {
    await load(FLOWCHART);
    await useGraphStore.getState().applyCode(BROKEN, { editing: true });

    // Half a line is broken code, and blanking the canvas on every keystroke
    // that has not finished is what this exists to avoid.
    const s = useGraphStore.getState();
    expect(s.parseError).toBeTruthy();
    expect(s.nodes.length).toBe(2);
  });

  it("drops the picture when the code came from somewhere else", async () => {
    await load(FLOWCHART);
    await load(BROKEN);

    // Switching to a document that does not parse used to leave the previous
    // diagram on the canvas: you were in Untitled 9 and looking at Untitled
    // 10. A document that has no picture shows none.
    const s = useGraphStore.getState();
    expect(s.parseError).toBeTruthy();
    expect(s.nodes).toEqual([]);
    expect(s.edges).toEqual([]);
  });

  it("drops the picture for an empty document too", async () => {
    await load(FLOWCHART);
    await load("");

    expect(useGraphStore.getState().parseError).toBeTruthy();
    expect(useGraphStore.getState().nodes).toEqual([]);
    expect(useGraphStore.getState().edges).toEqual([]);
  });

  it("clears a warning left over from the document before", async () => {
    await load(FLOWCHART);
    useGraphStore.setState({ warning: "something about the last one" });
    await load(BROKEN);

    expect(useGraphStore.getState().warning).toBeNull();
  });

  it("clears the read-only flag left over from an unsupported document", async () => {
    await load(GANTT);
    expect(useGraphStore.getState().unsupported).toBe("gantt");

    await load(BROKEN);
    expect(useGraphStore.getState().unsupported).toBeNull();
    expect(useGraphStore.getState().parseError).toBeTruthy();
  });
});

describe("history", () => {
  it("undoes and redoes a structural edit", async () => {
    await load(FLOWCHART);
    const before = useGraphStore.getState().code;

    useGraphStore.getState().addNode({ type: "shape", shape: "square" }, { x: 0, y: 0 });
    const after = useGraphStore.getState().code;
    expect(after).not.toBe(before);
    expect(useGraphStore.getState().canUndo).toBe(true);

    await useGraphStore.getState().undo();
    expect(useGraphStore.getState().code).toBe(before);
    expect(useGraphStore.getState().canRedo).toBe(true);

    await useGraphStore.getState().redo();
    expect(useGraphStore.getState().code).toBe(after);
  });

  it("undoes a drag through a colour picker in one step", async () => {
    // Each colour crossed on the way was a step of its own, so undo walked
    // back through all of them.
    await load(FLOWCHART);
    const before = useGraphStore.getState().code;
    const { updateNodeData } = useGraphStore.getState();
    for (const fill of ["#111111", "#222222", "#333333"]) {
      updateNodeData("a", { styles: [`fill:${fill}`] }, { burst: "fill" });
    }
    expect(useGraphStore.getState().code).toContain("fill:#333333");

    await useGraphStore.getState().undo();
    expect(useGraphStore.getState().code).toBe(before);
  });

  it("keeps two separate changes two steps of undo", async () => {
    await load(FLOWCHART);
    const { updateNodeData } = useGraphStore.getState();
    updateNodeData("a", { styles: ["fill:#111111"] }, { burst: "fill" });
    const first = useGraphStore.getState().code;
    updateNodeData("a", { styles: ["fill:#111111", "stroke:#222222"] }, { burst: "stroke" });

    await useGraphStore.getState().undo();
    expect(useGraphStore.getState().code).toBe(first);
  });

  it("reports nothing to undo on a freshly loaded diagram", async () => {
    useGraphStore.setState({ canUndo: false, canRedo: false });
    await load(FLOWCHART);
    await useGraphStore.getState().undo();
    expect(useGraphStore.getState().code).toBe(FLOWCHART);
  });
});

describe("clipboard", () => {
  it("pastes copies with fresh ids, leaving the originals intact", async () => {
    await load(FLOWCHART);
    useGraphStore.getState().selectAll();
    useGraphStore.getState().copySelection();
    useGraphStore.getState().pasteClipboard();

    const { nodes } = useGraphStore.getState();
    expect(nodes.length).toBe(4);
    expect(new Set(nodes.map((n) => n.id)).size).toBe(4);
    // The originals survive the paste.
    for (const id of ["a", "b"]) expect(nodes.some((n) => n.id === id)).toBe(true);
  });

  it("carries edges between copied nodes across", async () => {
    await load(FLOWCHART);
    useGraphStore.getState().selectAll();
    useGraphStore.getState().copySelection();
    useGraphStore.getState().pasteClipboard();
    expect(useGraphStore.getState().edges.length).toBe(2);
  });
});

describe("copying for other applications", () => {
  const GROUPED = [
    "flowchart LR",
    "  subgraph g[Zone]",
    "    a[One] --> b[Two]",
    "  end",
    "  b --> c[Three]",
    "",
  ].join("\n");
  const select = (ids: string[]) =>
    useGraphStore.setState({
      nodes: useGraphStore
        .getState()
        .nodes.map((n) => ({ ...n, selected: ids.includes(n.id) })),
    });

  it("hands over the whole diagram when nothing is selected", async () => {
    await load(GROUPED);
    select([]);
    const part = useGraphStore.getState().copiedPart();
    expect(part.code).toBe(useGraphStore.getState().code);
    expect(part.nodes.length).toBe(useGraphStore.getState().nodes.length);
  });

  it("writes the Mermaid of the selection alone", async () => {
    await load(GROUPED);
    select(["b", "c"]);
    const { code, edges } = useGraphStore.getState().copiedPart();
    expect(code).toContain("b --> c");
    expect(code).not.toContain("One");
    expect(code).not.toContain("subgraph");
    expect(edges.map((e) => [e.source, e.target])).toEqual([["b", "c"]]);
    // It is a diagram in its own right: it reads back without complaint.
    await load(code);
    expect(useGraphStore.getState().parseError).toBeNull();
    expect(
      useGraphStore
        .getState()
        .nodes.map((n) => n.id)
        .sort(),
    ).toEqual(["b", "c"]);
  });

  it("brings a group's contents with it", async () => {
    await load(GROUPED);
    select(["g"]);
    const { code } = useGraphStore.getState().copiedPart();
    expect(code).toContain("subgraph g");
    expect(code).toContain("a --> b");
    expect(code).not.toContain("Three");
  });

  it("keeps a node taken out of its group where it stood", async () => {
    await load(GROUPED);
    const { nodes } = useGraphStore.getState();
    const g = nodes.find((n) => n.id === "g")!;
    const b = nodes.find((n) => n.id === "b")!;
    select(["b"]);
    const [alone] = useGraphStore.getState().copiedPart().nodes;
    expect(alone.parentId).toBeUndefined();
    expect(alone.position).toEqual({
      x: g.position.x + b.position.x,
      y: g.position.y + b.position.y,
    });
  });
});

describe("pasting a picture", () => {
  const picture = { src: "data:image/png;base64,iVBORw0KGgo=", width: 120, height: 60 };

  it("places it as an image node centred where asked, selected", async () => {
    await load(FLOWCHART);
    expect(useGraphStore.getState().pasteImage(picture, { x: 300, y: 200 })).toBe(true);
    const node = useGraphStore.getState().nodes.at(-1)!;
    expect(node.position).toEqual({ x: 240, y: 170 });
    expect(node.selected).toBe(true);
    expect(useGraphStore.getState().nodes.filter((n) => n.selected)).toHaveLength(1);
    const code = useGraphStore.getState().code;
    expect(code).toContain(`img: "${picture.src}"`);
    expect(code).toContain("w: 120, h: 60");
    // And it reads back as the same picture.
    await load(code);
    expect(useGraphStore.getState().parseError).toBeNull();
  });

  it("is one step of undo", async () => {
    await load(FLOWCHART);
    const before = useGraphStore.getState().code;
    useGraphStore.getState().pasteImage(picture, { x: 0, y: 0 });
    await useGraphStore.getState().undo();
    expect(useGraphStore.getState().code).toBe(before);
  });

  it("is refused where Mermaid has no picture to draw it with", async () => {
    await load("sequenceDiagram\n  A->>B: hi\n");
    const count = useGraphStore.getState().nodes.length;
    expect(useGraphStore.getState().pasteImage(picture, { x: 0, y: 0 })).toBe(false);
    expect(useGraphStore.getState().nodes.length).toBe(count);
  });
});

describe("layout positions", () => {
  it("writes a positions comment that keeps the file valid mermaid", async () => {
    await load(FLOWCHART);
    useGraphStore.getState().addNode({ type: "shape", shape: "square" }, { x: 120, y: 80 });
    const code = useGraphStore.getState().code;
    expect(code).toContain("%% graph:positions");

    // Round-trip: reloading its own output must not error.
    await load(code);
    expect(useGraphStore.getState().parseError).toBeNull();
  });
});

describe("selection", () => {
  it("selects exactly one node, clearing any previous selection", async () => {
    await load(FLOWCHART);
    useGraphStore.getState().selectAll();
    expect(useGraphStore.getState().nodes.every((n) => n.selected)).toBe(true);

    useGraphStore.getState().selectOnly("a", "node");
    const { nodes, edges } = useGraphStore.getState();
    expect(nodes.filter((n) => n.selected).map((n) => n.id)).toEqual(["a"]);
    expect(edges.some((e) => e.selected)).toBe(false);
  });

  it("selects an edge without leaving nodes selected", async () => {
    await load(FLOWCHART);
    useGraphStore.getState().selectAll();
    const edgeId = useGraphStore.getState().edges[0].id;

    useGraphStore.getState().selectOnly(edgeId, "edge");
    const { nodes, edges } = useGraphStore.getState();
    expect(nodes.some((n) => n.selected)).toBe(false);
    expect(edges.filter((e) => e.selected).map((e) => e.id)).toEqual([edgeId]);
  });

  it("deletes the whole selection and the edges attached to it", async () => {
    await load(FLOWCHART);
    useGraphStore.getState().selectOnly("a", "node");
    useGraphStore.getState().deleteSelection();

    const { nodes, edges } = useGraphStore.getState();
    expect(nodes.map((n) => n.id)).toEqual(["b"]);
    // The a→b edge cannot outlive its source.
    expect(edges).toEqual([]);
  });

  it("nudges only the selected nodes, and only the positions comment", async () => {
    await load(FLOWCHART);
    useGraphStore.getState().selectOnly("a", "node");
    const before = useGraphStore.getState().nodes.find((n) => n.id === "a")!.position;
    const otherBefore = useGraphStore.getState().nodes.find((n) => n.id === "b")!.position;

    useGraphStore.getState().nudgeSelection(5, -3);

    const after = useGraphStore.getState().nodes.find((n) => n.id === "a")!.position;
    const otherAfter = useGraphStore.getState().nodes.find((n) => n.id === "b")!.position;
    expect(after).toEqual({ x: before.x + 5, y: before.y - 3 });
    expect(otherAfter).toEqual(otherBefore);

    // Structure untouched: the edge line survives verbatim.
    expect(useGraphStore.getState().code).toContain('a["One"] --> b["Two"]');
  });

  it("does nothing when nothing is selected", async () => {
    await load(FLOWCHART);
    useGraphStore.setState({
      nodes: useGraphStore.getState().nodes.map((n) => ({ ...n, selected: false })),
    });
    const before = useGraphStore.getState().code;
    useGraphStore.getState().nudgeSelection(10, 10);
    expect(useGraphStore.getState().code).toBe(before);
  });
});

describe("grouping", () => {
  it("wraps the selection in a group and reparents its members", async () => {
    await load(FLOWCHART);
    useGraphStore.getState().selectAll();
    useGraphStore.getState().groupSelection();

    const { nodes } = useGraphStore.getState();
    const group = nodes.find((n) => n.type === "group");
    expect(group).toBeDefined();
    for (const id of ["a", "b"]) {
      expect(nodes.find((n) => n.id === id)?.parentId).toBe(group!.id);
    }
    // A subgraph is the flowchart spelling of a group.
    expect(useGraphStore.getState().code).toContain("subgraph");
  });

  it("dissolves a group without taking its members with it", async () => {
    await load(FLOWCHART);
    useGraphStore.getState().selectAll();
    useGraphStore.getState().groupSelection();
    const group = useGraphStore.getState().nodes.find((n) => n.type === "group")!;

    useGraphStore.getState().selectOnly(group.id, "node");
    useGraphStore.getState().ungroupSelection();

    const { nodes } = useGraphStore.getState();
    expect(nodes.some((n) => n.type === "group")).toBe(false);
    expect(nodes.map((n) => n.id).sort()).toEqual(["a", "b"]);
    expect(nodes.every((n) => !n.parentId)).toBe(true);
    expect(useGraphStore.getState().code).not.toContain("subgraph");
  });

  it("lifts a single node out of its group, leaving the group behind", async () => {
    await load(FLOWCHART);
    useGraphStore.getState().selectAll();
    useGraphStore.getState().groupSelection();
    const group = useGraphStore.getState().nodes.find((n) => n.type === "group")!;

    useGraphStore.getState().removeFromGroup("a");

    const { nodes } = useGraphStore.getState();
    expect(nodes.find((n) => n.id === "a")?.parentId).toBeUndefined();
    expect(nodes.find((n) => n.id === "b")?.parentId).toBe(group.id);
    expect(nodes.some((n) => n.type === "group")).toBe(true);
  });

  it("deleting a group frees its members rather than destroying them", async () => {
    // Deliberate: `onNodesChange` re-parents orphans instead of cascading the
    // delete, so removing a container never silently takes content with it.
    // It does mean "Delete group" and "Ungroup" land in the same place —
    // tracked as an open UX question, not changed here.
    await load(FLOWCHART);
    useGraphStore.getState().selectAll();
    useGraphStore.getState().groupSelection();
    const group = useGraphStore.getState().nodes.find((n) => n.type === "group")!;

    useGraphStore.getState().deleteElement(group.id, "node");

    const { nodes } = useGraphStore.getState();
    expect(nodes.map((n) => n.id).sort()).toEqual(["a", "b"]);
    expect(nodes.every((n) => !n.parentId)).toBe(true);
  });
});

describe("duplicate", () => {
  it("copies a node under a fresh id, keeping the original", async () => {
    await load(FLOWCHART);
    useGraphStore.getState().duplicateNode("a");

    const { nodes } = useGraphStore.getState();
    expect(nodes.length).toBe(3);
    expect(nodes.filter((n) => n.id === "a").length).toBe(1);
    expect(new Set(nodes.map((n) => n.id)).size).toBe(3);
  });
});

describe("sequence message order", () => {
  const SEQUENCE = `sequenceDiagram
  participant a
  participant b
  a->>b: first
  loop retry
    a->>b: inner
  end
  a->>b: last
`;

  /** Row index of a message, by label, in the statement stream. */
  function rowOf(label: string): number {
    const s = useGraphStore.getState();
    return s.seqItems.findIndex(
      (it) =>
        it.kind === "message" && s.edges.find((e) => e.id === it.edgeId)?.data?.label === label,
    );
  }

  function edgeOf(label: string): string {
    return useGraphStore.getState().edges.find((e) => e.data?.label === label)!.id;
  }

  it("writes a message dropped between a block and its end inside the block", async () => {
    await load(SEQUENCE);
    // "last" sits at the top level, on the row after `end`.
    useGraphStore.getState().moveMessageTo(edgeOf("last"), rowOf("inner") + 1);

    expect(useGraphStore.getState().code).toContain(
      "  loop retry\n    a->>b: inner\n    a->>b: last\n  end\n",
    );
  });

  it("writes a message dragged past the end back out of the block", async () => {
    await load(SEQUENCE);
    const end = useGraphStore.getState().seqItems.findIndex((it) => it.kind === "end");
    useGraphStore.getState().moveMessageTo(edgeOf("inner"), end);

    const { code } = useGraphStore.getState();
    expect(code).toContain("  loop retry\n  end\n");
    expect(code).toContain("  a->>b: inner\n");
  });

  it("clamps a drop past either end of the stream", async () => {
    await load(SEQUENCE);
    useGraphStore.getState().moveMessageTo(edgeOf("last"), -5);
    expect(rowOf("last")).toBe(0);

    useGraphStore.getState().moveMessageTo(edgeOf("last"), 99);
    expect(rowOf("last")).toBe(useGraphStore.getState().seqItems.length - 1);
  });

  it("steps one row at a time from the inspector buttons", async () => {
    await load(SEQUENCE);
    const before = rowOf("last");
    useGraphStore.getState().moveMessage(edgeOf("last"), -1);
    expect(rowOf("last")).toBe(before - 1);
  });
});

describe("rearranging the diagram", () => {
  const BENT = `flowchart TD
  a["One"] --> b["Two"]
%% graph:positions {"a":{"x":40,"y":0},"b":{"x":40,"y":200}}
%% graph:waypoints {"a>b":[[160,100]]}
`;

  it("drops the corners, which belonged to the old arrangement", async () => {
    await load(BENT);
    expect(useGraphStore.getState().edges[0].data?.points).toHaveLength(1);

    await useGraphStore.getState().runAutoLayout();

    // Kept, a corner stays where it was dropped while the nodes move out from
    // under it, and the connection sets off sideways to a point that means
    // nothing any more.
    expect(useGraphStore.getState().edges[0].data?.points ?? []).toHaveLength(0);
    expect(useGraphStore.getState().code).not.toContain("graph:waypoints");
  });

  it("gives them back on undo, with the arrangement they belonged to", async () => {
    await load(BENT);
    const before = useGraphStore.getState().code;

    await useGraphStore.getState().runAutoLayout();
    await useGraphStore.getState().undo();

    expect(useGraphStore.getState().code).toBe(before);
    expect(useGraphStore.getState().edges[0].data?.points).toHaveLength(1);
  });

  it("shows the arrangement as in progress, then done", async () => {
    await load(BENT);
    useGraphStore.setState({ arranging: false });
    const seen: boolean[] = [];
    const unsub = useGraphStore.subscribe((s, prev) => {
      if (s.arranging !== prev.arranging) seen.push(s.arranging);
    });

    await useGraphStore.getState().runAutoLayout();
    unsub();

    expect(seen).toEqual([true, false]);
    expect(useGraphStore.getState().arranging).toBe(false);
  });

  it("remembers which arrangement the canvas sits in, and which one auto chose", async () => {
    await load(BENT);
    expect(useGraphStore.getState().lastArranged).toBeNull();

    await useGraphStore.getState().runAutoLayout("bands");
    expect(useGraphStore.getState().lastArranged).toBe("bands");

    // `auto` hides the winner inside `autoLayout`, so the remembered value is
    // exactly what the next test of the toolbar's tick reads off.
    await useGraphStore.getState().runAutoLayout("auto");
    const arranged = useGraphStore.getState().lastArranged;
    expect(["layered", "bands", "rectpacking", "mrtree", "force"]).toContain(arranged);
  });

  it("clears the memory on a loaded document, keeps it on a typed edit", async () => {
    await load(BENT);
    await useGraphStore.getState().runAutoLayout("force");
    expect(useGraphStore.getState().lastArranged).toBe("force");

    // Loading replaces the picture, so the claim would be about the last one.
    await load(BENT);
    expect(useGraphStore.getState().lastArranged).toBeNull();

    // A re-parse of the line being typed happens on top of the arrangement.
    await useGraphStore.getState().runAutoLayout("mrtree");
    await useGraphStore.getState().applyCode(BENT, { editing: true });
    expect(useGraphStore.getState().lastArranged).toBe("mrtree");
  });

  it("claims no arrangement for a sequence diagram", async () => {
    await load("sequenceDiagram\n  A->>B: hello\n");
    await useGraphStore.getState().runAutoLayout();
    expect(useGraphStore.getState().lastArranged).toBeNull();
  });

  it("leaves a label where the user dragged it", async () => {
    // A dragged label is stored as an offset from the middle of its route,
    // not as a coordinate, so it follows the connection when everything moves
    // and there is nothing to throw away.
    await load(`flowchart TD
  a["One"] -->|"why"| b["Two"]
%% graph:edges {"a>b":{"label":[40,-12]}}
`);
    const offset = useGraphStore.getState().edges[0].data?.style?.label;
    await useGraphStore.getState().runAutoLayout();
    expect(useGraphStore.getState().edges[0].data?.style?.label).toEqual(offset);
  });
});

describe("cropping a picture", () => {
  const picture = { src: "data:image/png;base64,iVBORw0KGgo=", width: 120, height: 60 };
  const cut = { src: "data:image/png;base64,Y3V0", width: 60, height: 60 };

  it("swaps in the cut picture at its new size, as one step of undo", async () => {
    await load(FLOWCHART);
    useGraphStore.getState().pasteImage(picture, { x: 0, y: 0 });
    const id = useGraphStore.getState().nodes.at(-1)!.id;
    const before = useGraphStore.getState().code;

    useGraphStore.getState().cropImage(id, cut);
    const node = useGraphStore.getState().nodes.find((n) => n.id === id)!;
    expect(node.data).toMatchObject({ img: cut.src, imgWidth: 60, imgHeight: 60 });
    expect(useGraphStore.getState().code).toContain(`img: "${cut.src}"`);

    await useGraphStore.getState().undo();
    expect(useGraphStore.getState().code).toBe(before);
  });

  it("shrinks a node given a size by what the picture lost", async () => {
    await load(FLOWCHART);
    useGraphStore.getState().pasteImage(picture, { x: 0, y: 0 });
    const id = useGraphStore.getState().nodes.at(-1)!.id;
    useGraphStore.setState({
      nodes: useGraphStore
        .getState()
        .nodes.map((n) => (n.id === id ? { ...n, style: { width: 136, height: 76 } } : n)),
    });
    useGraphStore.getState().cropImage(id, cut);
    const node = useGraphStore.getState().nodes.find((n) => n.id === id)!;
    expect(node.style).toMatchObject({ width: 76, height: 76 });
  });
});

describe("resizing a picture with no frame", () => {
  const picture = { src: "data:image/png;base64,iVBORw0KGgo=", width: 120, height: 60 };

  it("resizes the picture, in proportion, and lets the box hug it again", async () => {
    await load(FLOWCHART);
    useGraphStore.getState().pasteImage(picture, { x: 0, y: 0 });
    const id = useGraphStore.getState().nodes.at(-1)!.id;
    // Dragged out to a box far taller than the picture's proportions allow.
    useGraphStore.getState().setNodeSize(id, 256, 400, 0, 0);
    useGraphStore.getState().fitPictureTo(id, 256, 400);

    const node = useGraphStore.getState().nodes.find((n) => n.id === id)!;
    expect(node.data).toMatchObject({ imgWidth: 240, imgHeight: 120 });
    expect(node.style?.width).toBeUndefined();
    expect(node.style?.height).toBeUndefined();
    expect(useGraphStore.getState().code).toContain("w: 240, h: 120");
  });

  it("is what the size fields do to one too", async () => {
    await load(FLOWCHART);
    useGraphStore.getState().pasteImage(picture, { x: 0, y: 0 });
    const id = useGraphStore.getState().nodes.at(-1)!.id;
    useGraphStore.getState().resizeNode(id, 76, 400);
    const node = useGraphStore.getState().nodes.find((n) => n.id === id)!;
    expect(node.data).toMatchObject({ imgWidth: 60, imgHeight: 30 });
    expect(node.style?.width).toBeUndefined();
  });
});
