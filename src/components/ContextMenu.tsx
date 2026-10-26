import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useReactFlow } from "@xyflow/react";
import { absoluteBoxes, canGroup, useGraphStore } from "../store";
import { nearestSegment, type Point } from "../routing";
import type { AnyNode, FlowEdge } from "../model/types";
import { isGroup, type DiagramKind, type NodeSeed } from "../model/types";
import { useT } from "../i18n";
import { copyNow, pasteFromMenu } from "../clipboard";
import { canCopyImage } from "../export";

export interface MenuState {
  x: number;
  y: number;
  target: "node" | "edge" | "pane" | "selection";
  id?: string;
}

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
 * Which place in the corner list a corner dropped *here* should take.
 *
 * The order matters: put in the wrong place, a new corner sends the line
 * doubling back on itself. Node centres stand in for the ends — the handles'
 * exact positions belong to the renderer, and for deciding which stretch of
 * the line was clicked the centre is close enough.
 */
function cornerIndexAt(edge: FlowEdge | undefined, at: Point, nodes: AnyNode[]): number {
  const corners = edge?.data?.points ?? [];
  if (!edge || corners.length === 0) return 0;
  const boxes = absoluteBoxes(nodes);
  const centre = (id: string): Point | null => {
    const b = boxes.get(id);
    return b ? { x: b.x + b.w / 2, y: b.y + b.h / 2 } : null;
  };
  const route = [centre(edge.source), ...corners, centre(edge.target)].filter(
    (q): q is Point => q !== null,
  );
  return nearestSegment(route, at);
}

function focusInspectorLabel() {
  requestAnimationFrame(() => document.getElementById("inspector-label")?.focus());
}

export function ContextMenu({
  menu,
  onClose,
  onCropImage,
}: {
  menu: MenuState;
  onClose: () => void;
  /** Open the crop dialog for this node's picture. */
  onCropImage?: (id: string) => void;
}) {
  const { screenToFlowPosition } = useReactFlow();
  const ref = useRef<HTMLDivElement>(null);
  const firstItemRef = useRef<HTMLButtonElement>(null);
  const t = useT();

  useEffect(() => {
    // Focus into the menu on open, and hand focus back to whatever had it
    // when the menu closes — otherwise keyboard users are stranded.
    const restoreTo = document.activeElement as HTMLElement | null;
    firstItemRef.current?.focus();
    return () => restoreTo?.focus?.();
  }, []);

  useEffect(() => {
    // Capture phase: React Flow stops propagation of canvas mousedowns, so
    // bubble-phase window listeners never fire — capture always does.
    const onDown = (e: Event) => {
      if (ref.current?.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("wheel", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("wheel", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  const s = useGraphStore.getState();
  const node = menu.target === "node" ? s.nodes.find((n) => n.id === menu.id) : undefined;

  const run = (fn: () => void) => () => {
    fn();
    onClose();
  };

  const items: Array<{ label: string; danger?: boolean; action: () => void }> = [];

  // Copy leaves a picture and the Mermaid both, and each application takes
  // the one it prefers; these force one, for when that is not the one wanted.
  const copyItems = [
    { label: t("menu.copy"), action: run(() => copyNow()) },
    ...(canCopyImage()
      ? [{ label: t("menu.copyAsImage"), action: run(() => copyNow("image")) }]
      : []),
    { label: t("menu.copyAsText"), action: run(() => copyNow("text")) },
  ];

  if (menu.target === "node" && node) {
    if (isGroup(node)) {
      items.push(
        { label: t("menu.rename"), action: run(() => focusInspectorLabel()) },
        { label: t("menu.ungroup"), action: run(() => s.ungroupSelection()) },
        ...copyItems,
        {
          label: t("menu.deleteGroup"),
          danger: true,
          action: run(() => s.deleteElement(node.id, "node")),
        },
      );
    } else {
      items.push(
        { label: t("menu.rename"), action: run(() => focusInspectorLabel()) },
        { label: t("menu.duplicate"), action: run(() => s.duplicateNode(node.id)) },
        ...copyItems,
      );
      if (node.type === "shape" && node.data.img && onCropImage) {
        items.push({ label: t("menu.cropImage"), action: run(() => onCropImage(node.id)) });
      }
      if (node.parentId) {
        items.push({
          label: t("menu.removeFromGroup"),
          action: run(() => s.removeFromGroup(node.id)),
        });
      }
      items.push({
        label: t("menu.delete"),
        danger: true,
        action: run(() => s.deleteElement(node.id, "node")),
      });
    }
  } else if (menu.target === "selection") {
    const count = s.nodes.filter((n) => n.selected).length;
    if (canGroup(s.kind)) {
      items.push({
        label: t("menu.groupNodes", { count }),
        action: run(() => s.groupSelection()),
      });
    }
    items.push(
      ...copyItems,
      {
        label: t("menu.duplicate"),
        action: run(() => {
          s.copySelection();
          s.pasteClipboard();
        }),
      },
      {
        label: t("menu.deleteSelection"),
        danger: true,
        action: run(() => s.deleteSelection()),
      },
    );
  } else if (menu.target === "edge" && menu.id) {
    const id = menu.id;
    const edge = s.edges.find((e) => e.id === id);
    const corners = edge?.data?.points ?? [];
    const at = screenToFlowPosition({ x: menu.x, y: menu.y }, { snapToGrid: false });

    /**
     * The corner right-clicked on, if the pointer is near enough to one to
     * have meant it. Twenty units is about the dot itself at ordinary zoom —
     * far enough to be forgiving, near enough that "remove" never takes away
     * a corner the user was not pointing at.
     */
    const nearest = corners.reduce<{ index: number; away: number }>(
      (best, q, i) => {
        const away = Math.hypot(q.x - at.x, q.y - at.y);
        return away < best.away ? { index: i, away } : best;
      },
      { index: -1, away: Infinity },
    );
    const onCorner = nearest.index >= 0 && nearest.away <= 20;

    items.push({ label: t("menu.editLabel"), action: run(() => focusInspectorLabel()) });
    // Adding and removing corners lives here rather than in a list of
    // coordinates in the side panel: you point at the place you mean.
    if (onCorner) {
      items.push({
        label: t("menu.removeCorner"),
        action: run(() => s.removeWaypoint(id, nearest.index)),
      });
    } else {
      items.push({
        label: t("menu.addCornerHere"),
        action: run(() => s.addWaypoint(id, cornerIndexAt(edge, at, s.nodes), at)),
      });
    }
    if (corners.length > 0) {
      items.push({ label: t("menu.straighten"), action: run(() => s.clearWaypoints(id)) });
    }
    items.push({
      label: t("menu.delete"),
      danger: true,
      action: run(() => s.deleteElement(id, "edge")),
    });
  } else {
    items.push(
      {
        label: t("menu.addNodeHere"),
        action: run(() =>
          s.addNode(DEFAULT_SEED[s.kind], screenToFlowPosition({ x: menu.x, y: menu.y })),
        ),
      },
      {
        label: t("menu.paste"),
        action: run(() => void pasteFromMenu(screenToFlowPosition({ x: menu.x, y: menu.y }))),
      },
      ...copyItems,
      { label: t("menu.autoLayout"), action: run(() => void s.runAutoLayout()) },
    );
  }

  /** Arrow / Home / End move focus between items, as a menu should. */
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    if (buttons.length === 0) return;
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? buttons.length - 1
          : e.key === "ArrowDown"
            ? (at + 1) % buttons.length
            : (at - 1 + buttons.length) % buttons.length;
    buttons[next].focus();
  };

  return (
    <div
      ref={ref}
      className="context-menu"
      style={{ left: menu.x, top: menu.y }}
      role="menu"
      aria-label={t("menu.actions")}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      {items.map((item, i) => (
        <button
          key={item.label}
          className={`context-item${item.danger ? " danger" : ""}`}
          role="menuitem"
          // Focus the first item on open so the menu is usable from the
          // keyboard and Escape has somewhere sensible to return from.
          ref={i === 0 ? firstItemRef : undefined}
          onClick={item.action}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
