import { useEffect, useState } from "react";
import {
  ConnectionMode,
  ReactFlow,
  ReactFlowProvider,
  useNodesInitialized,
  useReactFlow,
  Background,
  Controls,
  type EdgeTypes,
  type NodeTypes,
} from "@xyflow/react";
import { ShapeNodeView, GroupNodeView } from "./ShapeNode";
import { ClassNodeView, EntityNodeView, MarkerDefs, StateNodeView } from "./KindNodes";
import { MessageEdge, ParticipantNodeView } from "./SequenceView";
import { C4NodeView, JunctionNodeView, ServiceNodeView } from "./ArchView";
import { NoteNodeView } from "./NoteNode";
import { RoutedEdge } from "./RoutedEdge";
import { parseDiagram } from "../model/diagram";
import { readPositions } from "../model/positions";
import { autoLayout } from "../layout/autoLayout";
import { annotateParallel, placeNodes, withStoredLooks } from "../store";
import { StaticGraphProvider } from "./GraphSource";
import { useT } from "../i18n";
import type { AnyNode, DiagramKind, FlowEdge } from "../model/types";

/**
 * The same node components the editor draws with, so the preview is not an
 * approximation of the canvas — it *is* the canvas, without the editing.
 */
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
  // Drawn by the router like any other connection: it gives each its own
  // berth on the face and its own lane, as the exported SVG does. The arc
  // this used to be hung from React Flow's first handle, which is the left
  // face — so a connection to a node on the right left from behind its own
  // box and crossed it.
  parallel: RoutedEdge,
  routed: RoutedEdge,
};

/** A little air around the diagram, so it does not touch the frame. */
const FIT = { padding: 0.06, duration: 0 };

/**
 * The flow itself, inside the provider so it can re-fit once measured.
 *
 * React Flow measures nodes after the first paint, so the `fitView` it does
 * on mount is computed from nodes with no size — which is why a diagram
 * arrived off-centre and half out of frame. `onNodesInitialized` fires once
 * the real sizes are known, and that is the fit that counts.
 */
function Flow({ nodes, edges }: { nodes: AnyNode[]; edges: FlowEdge[] }) {
  const { fitView } = useReactFlow();
  const measured = useNodesInitialized();

  useEffect(() => {
    if (!measured) return;
    void fitView(FIT);
    // A group is measured after the children that size it, so one fit on
    // `measured` can still be computed from a container that has not grown
    // yet. A second pass on the next frame catches that.
    const again = requestAnimationFrame(() => void fitView(FIT));
    return () => cancelAnimationFrame(again);
  }, [measured, fitView, nodes]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      fitView
      fitViewOptions={FIT}
      // The canvas runs loose, and so must this: every handle a node offers
      // is a `source`, and without loose mode React Flow refuses to attach
      // an edge whose target handle is unnamed — which silently dropped
      // every connection and left a preview of boxes and nothing between.
      connectionMode={ConnectionMode.Loose}
      // Read-only: this is a preview, and an edit here would have nowhere to
      // go — the document has not been placed yet.
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={18} />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}

/**
 * A read-only Archyne canvas for a Mermaid document. *
 * Shown beside Mermaid's own rendering because the two do not look alike, and
 * the one that matters when deciding whether to accept an import is the one
 * the diagram will actually be edited on. React Flow brings its own zoom and
 * pan, which is the other half of being able to judge a large drawing.
 */
export function CanvasPreview({ code }: { code: string }) {
  const t = useT();
  // Keyed by the code they were built from, so a change shows the spinner
  // again without the effect having to reset state on the way in.
  const [graph, setGraph] = useState<{
    code: string;
    kind: DiagramKind;
    nodes: AnyNode[];
    edges: FlowEdge[];
  } | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);

  useEffect(() => {
    let alive = true;

    void (async () => {
      try {
        const parsed = await parseDiagram(code);
        // A sequence diagram is not laid out from geometry: its rows come
        // from the order of the messages, which lives in the store's
        // `seqItems` and not in the document. Drawing it here would put every
        // participant in a column with nothing between them, so the preview
        // says so and points at the rendering that can show it.
        if (parsed.kind === "sequence") {
          if (alive) setGraph({ code, kind: "sequence", nodes: [], edges: [] });
          return;
        }
        // The same order the editor uses: positions out of the document when
        // it carries them, ELK when it does not.
        // Exactly the order the editor uses. In particular the layout runs
        // over *placed* nodes, not the bare parse: ELK needs each node's size
        // to lay one out, and `placeNodes` is what gives it one. Handing it
        // the bare nodes — as this first did — laid every architecture
        // diagram out as a column of boxes overlapping their own groups.
        const stored = readPositions(code);
        let nodes = placeNodes(parsed.nodes, stored ?? {}, parsed.kind);
        if (!stored) {
          const laid = (await autoLayout(nodes, parsed.edges, parsed.direction)).positions;
          nodes = placeNodes(parsed.nodes, laid, parsed.kind);
        }
        // Its node looks, corners and connection styles too, or an imported
        // drawing's connections are routed from scratch here and look
        // nothing like they will on the canvas.
        const looked = withStoredLooks(code, nodes, parsed.edges);
        const edges = annotateParallel(parsed.kind, looked.edges);
        if (alive) setGraph({ code, kind: parsed.kind, nodes: looked.nodes, edges });
      } catch (err) {
        if (alive)
          setError({ code, message: err instanceof Error ? err.message : String(err) });
      }
    })();

    return () => {
      alive = false;
    };
  }, [code]);

  if (error?.code === code) return <div className="preview-error">{error.message}</div>;
  if (graph?.code !== code) return <div className="palette-hint">{t("import.rendering")}</div>;
  if (graph.nodes.length === 0)
    return <div className="palette-hint">{t("import.noCanvas")}</div>;

  return (
    <ReactFlowProvider>
      {/* Arrowheads live in a defs block beside the flow, as they do on the
          canvas — an edge with no marker is an edge with no arrow. */}
      <MarkerDefs />
      {/* The edge components route from the whole graph, not from their own
          two endpoints, so they need to be told which graph this is. */}
      <StaticGraphProvider graph={{ nodes: graph.nodes, edges: graph.edges, kind: graph.kind }}>
        <Flow nodes={graph.nodes} edges={graph.edges} />
      </StaticGraphProvider>
    </ReactFlowProvider>
  );
}
