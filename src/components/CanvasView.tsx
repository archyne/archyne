import { useCallback, useEffect, useMemo, useState } from "react";
import { ContextMenu, type MenuState } from "./ContextMenu";
import {
  Background,
  ConnectionMode,
  Controls,
  MiniMap,
  ReactFlow,
  SelectionMode,
  useReactFlow,
  type NodeTypes,
} from "@xyflow/react";
import { useRef } from "react";
import { useGraphStore } from "../store";
import type { AnyNode, DiagramKind, FlowEdge, NodeSeed } from "../model/types";
import { GroupNodeView, ShapeNodeView } from "./ShapeNode";
import { ClassNodeView, EntityNodeView, MarkerDefs, StateNodeView } from "./KindNodes";
import { MessageEdge, ParticipantNodeView } from "./SequenceView";
import { C4NodeView, JunctionNodeView, ServiceNodeView } from "./ArchView";
import { ParallelEdge } from "./ParallelEdge";
import { RoutedEdge } from "./RoutedEdge";
import { NoteNodeView } from "./NoteNode";
import { SequenceOverlay } from "./SequenceOverlay";
import { useKeyboardConnect } from "./useKeyboardConnect";
import { useDragGuides } from "./useDragGuides";
import { useCoarsePointer } from "./useMediaQuery";
import { GuideLines } from "./GuideLines";
import { GRID } from "../guides";
import { MermaidPreview } from "./MermaidPreview";
import { useT } from "../i18n";
import type { EdgeTypes } from "@xyflow/react";
import { isGroup } from "../model/types";

const nodeTypes: NodeTypes = {
  shape: ShapeNodeView,
  group: GroupNodeView,
  state: StateNodeView,
  entity: EntityNodeView,
  class: ClassNodeView,
  participant: ParticipantNodeView,
  service: ServiceNodeView,
  junction: JunctionNodeView,
  c4: C4NodeView,
  note: NoteNodeView,
};

const edgeTypes: EdgeTypes = {
  message: MessageEdge,
  parallel: ParallelEdge,
  routed: RoutedEdge,
};

/**
 * The size of the minimap, passed as inline style rather than set in CSS.
 *
 * The default is a 200×150 slab; at this size it reads as a navigation aid
 * rather than a second diagram competing with the real one. It has to be
 * given here because React Flow sizes its `<svg>` and lays out its viewBox
 * from `style.width`/`style.height`, falling back to that 200×150 default —
 * shrinking the box in the stylesheet alone leaves the drawing at its
 * original size and aspect, so the viewport rectangle spills out of the box
 * as soon as the canvas is panned.
 */
const MINIMAP_SIZE = { width: 148, height: 104 };

const DEFAULT_SEED: Record<DiagramKind, NodeSeed> = {
  flowchart: { type: "shape", shape: "square" },
  state: { type: "state", stateType: "normal" },
  er: { type: "entity" },
  class: { type: "class" },
  sequence: { type: "participant", ptype: "participant" },
  architecture: { type: "service", icon: "server" },
  c4: { type: "c4", c4Shape: "system" },
};

/**
 * The node the pointer was over when a connection was let go.
 *
 * From the document rather than from React Flow's own answer, which is a
 * connection *point* within reach and so tells us nothing about the node the
 * gesture ended on. The innermost node wins: a child inside a group is what
 * the pointer is over, not the group behind it.
 */
function nodeIdAt(event: MouseEvent | TouchEvent): string | undefined {
  const at = "changedTouches" in event ? event.changedTouches[0] : event;
  if (!at) return undefined;
  const el = document.elementFromPoint(at.clientX, at.clientY);
  return el?.closest<HTMLElement>(".react-flow__node")?.dataset.id;
}

export function CanvasView() {
  const nodes = useGraphStore((s) => s.nodes);
  const edges = useGraphStore((s) => s.edges);
  const kind = useGraphStore((s) => s.kind);
  const arranging = useGraphStore((s) => s.arranging);
  const accTitle = useGraphStore((s) => s.accTitle);
  const accDescr = useGraphStore((s) => s.accDescr);
  const onNodesChange = useGraphStore((s) => s.onNodesChange);
  const onEdgesChange = useGraphStore((s) => s.onEdgesChange);
  const onConnect = useGraphStore((s) => s.onConnect);
  const onNodeDragStop = useGraphStore((s) => s.onNodeDragStop);
  const addNode = useGraphStore((s) => s.addNode);
  const selectOnly = useGraphStore((s) => s.selectOnly);
  const { screenToFlowPosition, fitView } = useReactFlow();
  const fitSeq = useGraphStore((s) => s.fitSeq);
  const [menu, setMenu] = useState<MenuState | null>(null);

  /**
   * Fit the drawing into view when the store asks.
   *
   * Replacing the document does not move the viewport, so a diagram that grew
   * downwards put its new part off the bottom of the screen and the canvas
   * looked untouched. The store bumps a counter when something replaced the
   * drawing wholesale; this answers it. Deliberately not on `nodes`: fitting
   * on every change would yank the viewport around while someone is working.
   */
  useEffect(() => {
    if (fitSeq === 0) return;
    // After the nodes have been measured, or the fit is computed against
    // boxes that do not have their real size yet.
    const id = requestAnimationFrame(() => void fitView({ duration: 200 }));
    return () => cancelAnimationFrame(id);
  }, [fitSeq, fitView]);
  const connect = useKeyboardConnect();
  /**
   * Whether a connection is being dragged, so the canvas can show every
   * node's connection points while it is.
   *
   * They are hidden the rest of the time — four dots on every node at every
   * moment sat over the labels and the icons they were meant to serve — and
   * shown on the node under the pointer and on the selected one. That is
   * enough to start a connection but not to finish one: the node being aimed
   * at is nowhere near the pointer when the drag begins.
   */
  const [connecting, setConnecting] = useState(false);
  const dragGuides = useDragGuides();
  const coarse = useCoarsePointer();
  const unsupported = useGraphStore((s) => s.unsupported);
  const parseError = useGraphStore((s) => s.parseError);
  const code = useGraphStore((s) => s.code);
  const t = useT();
  /** True when the pointer moved the viewport since the last mousedown —
   * used to not open the context menu after a right-button pan. */
  const panMovedRef = useRef(false);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      const raw = e.dataTransfer.getData("application/x-graph-node");
      if (!raw) return;
      e.preventDefault();
      addNode(
        JSON.parse(raw) as NodeSeed,
        screenToFlowPosition({ x: e.clientX, y: e.clientY }),
      );
    },
    [addNode, screenToFlowPosition],
  );

  // Mark the pending connection source so it is visible, not just announced.
  const flowNodes = useMemo(
    () =>
      connect.source
        ? nodes.map((n) =>
            n.id === connect.source
              ? { ...n, className: `${n.className ?? ""} connect-source`.trim() }
              : n,
          )
        : nodes,
    [nodes, connect.source],
  );

  if (unsupported) {
    // Valid Mermaid we cannot edit visually. Render it rather than refusing
    // the file; the code panel stays fully editable.
    return (
      <main className="canvas-wrap read-only" aria-label={t("canvas.label")}>
        <div className="read-only-banner" role="status">
          <strong>{t("unsupported.title", { type: unsupported })}</strong>
          <span>{t("unsupported.body")}</span>
        </div>
        <MermaidPreview code={code} className="read-only-preview" />
      </main>
    );
  }

  return (
    <main
      className={`canvas-wrap${connecting ? " connecting" : ""}`}
      /* A diagram's own accessible title names the region when the author
         gave one — "Payment flow — diagram canvas" rather than the same
         generic label on every diagram. */
      aria-label={accTitle ? `${accTitle} — ${t("canvas.label")}` : t("canvas.label")}
      aria-describedby="canvas-summary"
      onMouseDownCapture={() => (panMovedRef.current = false)}
    >
      <MarkerDefs />
      <ReactFlow<AnyNode, FlowEdge>
        nodes={flowNodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onConnectStart={() => setConnecting(true)}
        onConnectEnd={(event, connection) => {
          setConnecting(false);
          // React Flow finishes a connection only when it is let go within
          // `connectionRadius` of a connection point. That is a distance
          // from a *point*, so whether the middle of a node counts depends
          // on how big the node is: released dead centre, a 160×54 flowchart
          // box connected and a 180×174 service did not — the same gesture,
          // two answers, for a reason nobody can see. Released anywhere on a
          // node, it connects, which is what draw.io does.
          if (connection.isValid || !connection.fromNode) return;
          const target = nodeIdAt(event);
          // Not the node it came from: with the whole node a target, every
          // abandoned drag that wandered back over its own node would leave
          // a loop behind. A deliberate one still works — released on a
          // point of the same node, which React Flow accepts itself.
          if (!target || target === connection.fromNode.id) return;
          // Not a group either. A container covers most of the canvas, and
          // "anywhere on it" would turn every drag that ends in open space
          // inside one into a connection to the container. Its own points
          // are still there for the times that is what you meant.
          const node = useGraphStore.getState().nodes.find((n) => n.id === target);
          if (!node || isGroup(node)) return;
          onConnect({
            source: connection.fromNode.id,
            target,
            sourceHandle: connection.fromHandle?.id ?? null,
            targetHandle: null,
          });
        }}
        onNodeDrag={(_, __, dragged) => dragGuides.track(dragged)}
        onNodeDragStop={(_, node, dragged) => {
          dragGuides.settle(dragged);
          onNodeDragStop(node);
        }}
        onDrop={onDrop}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        }}
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement).classList.contains("react-flow__pane")) {
            addNode(DEFAULT_SEED[kind], screenToFlowPosition({ x: e.clientX, y: e.clientY }));
          }
        }}
        onEdgeDoubleClick={(_, edge) => {
          void edge;
          requestAnimationFrame(() => document.getElementById("inspector-label")?.focus());
        }}
        onNodeDoubleClick={(_, node) => {
          if (node.type === "shape") return; // shape nodes edit inline
          requestAnimationFrame(() => document.getElementById("inspector-label")?.focus());
        }}
        onNodeContextMenu={(e, node) => {
          e.preventDefault();
          // Right-clicking a node that is part of a multi-selection acts on
          // the whole selection, like draw.io.
          const selectedCount = nodes.filter((n) => n.selected).length;
          if (node.selected && selectedCount > 1) {
            setMenu({ x: e.clientX, y: e.clientY, target: "selection" });
            return;
          }
          selectOnly(node.id, "node");
          setMenu({ x: e.clientX, y: e.clientY, target: "node", id: node.id });
        }}
        onSelectionContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY, target: "selection" });
        }}
        onEdgeContextMenu={(e, edge) => {
          e.preventDefault();
          selectOnly(edge.id, "edge");
          setMenu({ x: e.clientX, y: e.clientY, target: "edge", id: edge.id });
        }}
        onPaneContextMenu={(e) => {
          e.preventDefault();
          if (panMovedRef.current) return; // it was a right-button pan
          setMenu({
            x: (e as React.MouseEvent).clientX,
            y: (e as React.MouseEvent).clientY,
            target: "pane",
          });
        }}
        /* A mouse drags a selection rectangle and pans with the middle or
           right button. A touchscreen has neither of those buttons, so there
           the same gesture has to pan — otherwise a finger only ever draws a
           marquee and the diagram cannot be moved at all. */
        selectionOnDrag={!coarse}
        selectionMode={SelectionMode.Partial}
        panOnDrag={coarse ? true : [1, 2]}
        onMove={() => (panMovedRef.current = true)}
        connectionMode={ConnectionMode.Loose}
        connectionRadius={38}
        snapToGrid
        snapGrid={[GRID, GRID]}
        fitView
        proOptions={{ hideAttribution: true }}
        deleteKeyCode={["Delete", "Backspace"]}
      >
        <Background gap={18} />
        <GuideLines />
        {kind === "sequence" && <SequenceOverlay />}
        <Controls />
        <MiniMap pannable zoomable style={MINIMAP_SIZE} />
      </ReactFlow>
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}

      {/* Arranging runs the layout engine, which takes its time on a large
          drawing. Laid over the canvas and inert, so the drawing underneath
          keeps panning and the gesture that asked for it stays answered —
          a slow arrangement must not read as a dead one. */}
      {arranging && (
        <div className="canvas-arranging" role="status">
          <span className="canvas-arranging-spinner" aria-hidden="true" />
          <span>{t("canvas.arranging")}</span>
        </div>
      )}

      {/* Why the canvas is bare.
          Code that does not parse leaves nothing to draw — and since a
          document that has just been switched to no longer keeps the
          previous one's picture, "nothing to draw" now means an empty
          canvas. Without this it is an empty canvas that says nothing, and
          an empty document and a broken one look identical.

          Laid over the canvas rather than replacing it, and inert, so
          everything the canvas still does — panning, dropping a shape,
          the context menu — goes on working underneath. Not a live region
          either: `StatusAnnouncer` already announces the parse error, and
          two of them would say it twice. */}
      {parseError && nodes.length === 0 && (
        <div className="canvas-blank" aria-hidden="true">
          <strong>{t(code.trim() ? "canvas.brokenTitle" : "canvas.emptyTitle")}</strong>
          <span>{t(code.trim() ? "canvas.brokenBody" : "canvas.emptyBody")}</span>
        </div>
      )}
      {/* How to drive the canvas without a pointer. Visible to screen
          readers only; sighted users have the palette and drag handles. */}
      {/* What is on the canvas, before how to drive it. A screen reader
          lands here with no way to perceive the shape of the diagram, so it
          is stated: the family, how much of it there is, the author's own
          description when there is one, and where the readable version is.
          The Outline tab is that version; this points at it rather than
          pretending the canvas is self-describing. */}
      <p className="visually-hidden" id="canvas-summary">
        {t("canvas.summary", {
          kind: t(`kind.${kind}`),
          nodes: String(nodes.filter((n) => !isGroup(n)).length),
          groups: String(nodes.filter(isGroup).length),
          edges: String(edges.length),
        })}
        {accDescr ? ` ${accDescr}` : ""}
      </p>
      <p className="visually-hidden">{t("canvas.keyboardHelp")}</p>
      <p className="visually-hidden" role="status" aria-atomic="true">
        {connect.message}
      </p>
    </main>
  );
}
