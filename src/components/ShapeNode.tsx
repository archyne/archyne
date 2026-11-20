import { useState } from "react";
import { Label } from "./Label";
import { useRename } from "./useRename";
import { useGraphView } from "./useGraphView";
import { labelPlaceOf, labelStyleOf, readableLabel, styleProps } from "../model/nodeStyle";
import { NodeResizer, useInternalNode, type NodeProps } from "@xyflow/react";
import type { AnyNode, Shape, ShapeNode as ShapeNodeType } from "../model/types";
import { IMG_SIZE, defaultSize } from "../model/types";
import { GROUP_MIN, useGraphStore } from "../store";
import { NodeResize } from "./NodeResize";
import { IconView } from "./ArchView";
import { SideHandles } from "./SideHandles";
import { pointsAttr, shapeGeometry } from "../render/shapes";
import { COMPACT_SHAPE } from "../render/boxModel";
import { absoluteBoxes } from "../boxes";
import { useThemeStore } from "../theme";
import { readableOn } from "../model/importShared";

/**
 * The canvas's adapter over `render/shapes.ts`.
 *
 * The geometry itself lives there, so that the renderer which emits SVG as a
 * string draws the same hexagon this does. All that is left here is turning a
 * primitive into an element and hanging the right class on it.
 */
/**
 * A node's type, as it can be read where it is drawn.
 *
 * A drawing brought in from draw.io or Visio was made on a white page, and
 * its words with no box of their own — a room's name, a caption under an
 * icon — are in a dark colour chosen to read on white. On the dark canvas
 * they were dark on dark, and the drawing looked like boxes with nothing
 * written in them. Words standing on the canvas itself, in a colour too dark
 * to read there, are drawn in the theme's own colour instead. Only on the
 * canvas: the file keeps the colour it was given, and words on a fill of
 * their own are left as they are.
 */
function onCanvas<T extends { color?: string }>(style: T, dark: boolean, onPage: boolean): T {
  if (!dark || !onPage || !style.color) return style;
  const colour = style.color.replace(/^(#[0-9a-f]{6})[0-9a-f]{2}$/i, "$1");
  return readableOn(colour) === "#ffffff" ? { ...style, color: undefined } : style;
}

/**
 * The nodes standing on something filled — a container, or a box drawn
 * beneath them — rather than straight on the canvas. Words there were
 * coloured to read on that fill, and are left as they are.
 *
 * By place, not by parentage: a draw.io room is as often a box laid under
 * its devices as a container holding them, and the names on it were turned
 * pale for the canvas and vanished on the pale box.
 */
const panelled = new WeakMap<AnyNode[], Set<string>>();
function onFilled(nodes: AnyNode[]): Set<string> {
  const known = panelled.get(nodes);
  if (known) return known;
  const boxes = absoluteBoxes(nodes);
  const filled = nodes.filter((n) => {
    const fill = styleProps((n.data as { styles?: string[] }).styles ?? []).fill;
    if (n.type === "group") return !!fill && !/^(none|transparent)$/.test(fill);
    return !!fill && !/^(none|transparent)$/.test(fill) && !(n.data as { img?: string }).img;
  });
  const out = new Set<string>();
  for (const n of nodes) {
    const b = boxes.get(n.id);
    if (!b) continue;
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    for (const f of filled) {
      if (f === n) continue;
      const fb = boxes.get(f.id);
      if (fb && cx > fb.x && cx < fb.x + fb.w && cy > fb.y && cy < fb.y + fb.h) {
        out.add(n.id);
        break;
      }
    }
  }
  panelled.set(nodes, out);
  return out;
}

/**
 * A node's picture, or the space it would take when it cannot be had.
 *
 * A picture is a link, and a link can fail: an imported drawing's icons on
 * a site the page may not load from, or one that has gone. The browser's
 * broken-image glyph in its place read as the import being broken; the
 * space, kept the picture's size so nothing round it moves, reads as what it
 * is — a picture that is not here.
 */
function Picture({ src, width, height }: { src: string; width: number; height: number }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (failed === src) {
    return (
      <span className="shape-image missing" style={{ width, height }} aria-hidden="true" />
    );
  }
  return (
    <img
      className="shape-image"
      src={src}
      alt=""
      width={width}
      height={height}
      draggable={false}
      onError={() => setFailed(src)}
    />
  );
}

function shapeSvg(shape: Shape, w: number, h: number) {
  return (
    <g>
      {shapeGeometry(shape, w, h).map((p, i) => {
        // `.shape-fill` is the body and takes a node's custom colours;
        // `.shape-line` is detail drawn over it and is never filled.
        const common =
          p.paint === "fill"
            ? { className: "shape-fill", vectorEffect: "non-scaling-stroke" as const }
            : { className: "shape-line", fill: "none" };
        switch (p.kind) {
          case "rect":
            return (
              <rect
                key={i}
                x={p.x}
                y={p.y}
                width={p.width}
                height={p.height}
                {...(p.rx !== undefined ? { rx: p.rx } : {})}
                {...common}
              />
            );
          case "ellipse":
            return <ellipse key={i} cx={p.cx} cy={p.cy} rx={p.rx} ry={p.ry} {...common} />;
          case "polygon":
            return <polygon key={i} points={pointsAttr(p.points)} {...common} />;
          case "path":
            return <path key={i} d={p.d} {...common} />;
          case "line":
            return <line key={i} x1={p.x1} y1={p.y1} x2={p.x2} y2={p.y2} {...common} />;
        }
      })}
    </g>
  );
}

export function ShapeNodeView({ id, data, selected }: NodeProps<ShapeNodeType>) {
  const classDefs = useGraphStore((s) => s.classDefs);
  // The shape is drawn from real numbers rather than stretched, so a resized
  // diamond keeps its points sharp instead of scaling its strokes with it.
  //
  // Read from the node's own style, not from the `width` prop: that one is
  // the *measured* size, which is measured from the box this style produces.
  // Feeding it back in would make the element its own input, and one stray
  // pixel of rounding would then compound on every render.
  const style = useInternalNode(id)?.style;
  // A picture does not enlarge the box: it is fitted into whatever size the
  // node has, default or chosen. See `.shape-image` in the stylesheet.
  const fallback = defaultSize(data.shape);
  const w = Number(style?.width ?? fallback.width);
  const h = Number(style?.height ?? fallback.height);
  const custom = readableLabel(
    styleProps([
      ...(data.classes ?? []).flatMap((c) => classDefs[c] ?? []),
      ...(data.styles ?? []),
    ]),
  );
  // A picture with its frame switched off has no box to be fitted into, so
  // the node is the size of what it shows rather than a 160×54 rectangle
  // standing 50px clear of a 60px logo — which is also where the selection
  // outline and the arriving edges would otherwise stop. A size actually
  // chosen for the node still wins; dragging a handle chooses one.
  const bare = Boolean(data.img) && custom.fill === "none" && custom.stroke === "none";
  // Words with no box: no fill and no stroke. draw.io lets these run past
  // the box they were given, and imported ones are sized that tightly — so
  // with the usual padding, and clipped to the box, a caption read "Gateway
  // (to On-". They keep the words whole instead.
  const unboxed = (v?: string) => v === "none" || v === "transparent";
  const textOnly = !data.img && unboxed(custom.fill) && unboxed(custom.stroke);
  const fitted = bare && style?.width == null;
  // What the label is drawn with — and the rename field too, since it stands
  // in for the label and a field two sizes off the text it replaces is a
  // node that changes shape the moment you double-click it.
  const dark = useThemeStore((s) => s.resolved) === "dark";
  // Among the nodes of the drawing this one is in — the open document's, or
  // a preview's. Asked of the open document always, a node in the import
  // preview was never found standing on anything, so every caption there was
  // turned pale for the dark canvas and vanished on the pale box under it.
  const onPanel = onFilled(useGraphView().nodes).has(id);
  const labelStyle = labelStyleOf(onCanvas(custom, dark, (textOnly || bare) && !onPanel));

  // Renaming, shared with every other family. A flowchart label may hold a
  // second line, and mermaid spells one `<br>`.
  // The field is painted with the node's own fill, so a label coloured to
  // read on that fill still reads while it is typed. On the canvas's
  // background instead, the dark text an imported pale box carries was black
  // on black.
  const fieldFill =
    custom.fill && custom.fill !== "none" && custom.fill !== "transparent"
      ? ({ "--rename-bg": custom.fill } as React.CSSProperties)
      : {};
  const rename = useRename(id, data.label, {
    multiline: true,
    style: { ...labelStyle, ...fieldFill },
  });

  // A node made smaller than the label's padding allows — draw.io's 40×20
  // tags, `AV11` and `TO01`, are everywhere in imported diagrams — had a few
  // pixels left for its text, broke the one word into a letter a line, and
  // showed the first letter. `.compact` gives the words the room instead.
  const compact = style?.width != null && (w < COMPACT_SHAPE.width || h < COMPACT_SHAPE.height);

  return (
    <div
      className={
        `shape-node${selected ? " selected" : ""}${bare ? " bare" : ""}` +
        (style?.width == null ? "" : " sized") +
        (compact ? " compact" : "") +
        (textOnly ? " text-only" : "")
      }
      style={
        fitted ? undefined : { width: w, height: h, ...(data.img ? {} : labelPlaceOf(custom)) }
      }
      onDoubleClick={rename.begin}
    >
      <NodeResize id={id} visible={selected} picture={bare} />
      {/* Nothing to draw when the frame is off — and drawing it anyway would
          put a shape back on selection, since `.shape-node.selected` colours
          the outline the fill and stroke had blanked. */}
      {!bare && (
        <svg
          width={w}
          height={h}
          className="shape-svg"
          style={{
            ...(custom.fill ? ({ "--custom-fill": custom.fill } as React.CSSProperties) : {}),
            ...(custom.stroke
              ? ({ "--custom-stroke": custom.stroke } as React.CSSProperties)
              : {}),
            ...(custom.strokeWidth
              ? ({ "--custom-stroke-width": custom.strokeWidth } as React.CSSProperties)
              : {}),
          }}
        >
          {shapeSvg(data.shape, w, h)}
        </svg>
      )}
      {/* A node with a picture keeps it while its name is being typed: the
          field stands in for the words, not for the whole node. Renaming one
          used to blank the picture and, with no frame to hold the shape open,
          leave a lone text box where the icon had been.

          The field is inside the label in every case. Outside it, it lost
          the label's type size and came up in the browser's own sixteen
          pixels — the words grew the moment they were double-clicked, and
          there was no telling what they would look like once done. */}

      <div
        className={`shape-label${data.img ? ` with-image pos-${data.imgPos ?? "b"}` : ""}`}
        style={labelStyle}
      >
        {/* Mermaid's image shape, drawn the way mermaid draws it: the
              picture from its URL, the label above or below. Loaded from the
              network on purpose — that URL is the whole point of the shape,
              since it is what makes the icon appear in other tools too. */}
        {data.img && (
          <Picture
            src={data.img}
            width={data.imgWidth ?? IMG_SIZE}
            height={data.imgHeight ?? IMG_SIZE}
          />
        )}
        {rename.editing ? (
          rename.field
        ) : (
          <span>
            <Label text={data.label} />
          </span>
        )}
      </div>
      <SideHandles />
    </div>
  );
}

export function GroupNodeView({
  id,
  data,
  selected,
}: NodeProps<import("../model/types").GroupNode>) {
  const resizeEnd = useGraphStore((s) => s.onNodeDragStop);
  const setNodeSize = useGraphStore((s) => s.setNodeSize);
  // A container's name is a flowchart subgraph title, which mermaid lets
  // hold a `<br>` like any other flowchart label.
  const rename = useRename(id, data.label, { multiline: true });
  // The colours the diagram gives it — a `style` on the subgraph, a draw.io
  // panel's own. Without them, every imported panel was the same faint
  // tint, and a card stacked on another showed the one behind through it.
  const custom = readableLabel(styleProps(data.styles ?? []));
  const dark = useThemeStore((s) => s.resolved) === "dark";
  const onPanel = onFilled(useGraphView().nodes).has(id);
  const shown = onCanvas(
    custom,
    dark,
    (!custom.fill || /^(none|transparent)$/.test(custom.fill)) && !onPanel,
  );
  const paint = {
    ...(custom.fill ? { "--group-fill": custom.fill } : {}),
    ...(custom.stroke
      ? { "--group-stroke": custom.stroke === "none" ? "transparent" : custom.stroke }
      : {}),
    ...(shown.color ? { "--group-text": shown.color } : {}),
  } as React.CSSProperties;
  const painted = Boolean(custom.fill || custom.stroke) && !custom.strokeDasharray;
  // Its title set as the diagram sets it: the type, and where along the
  // strip it stands — centred, as draw.io centres a container's name unless
  // told otherwise.
  const titleStyle: React.CSSProperties = {
    ...labelStyleOf(shown),
    ...(custom.textAlign === "center"
      ? { justifyContent: "center" }
      : custom.textAlign === "right"
        ? { justifyContent: "flex-end" }
        : {}),
  };
  return (
    <div
      className={
        `group-node${selected ? " selected" : ""}` +
        (painted ? " painted" : "") +
        (data.style?.look && data.style.look !== "boxed" ? ` ${data.style.look}` : "")
      }
      style={paint}
    >
      <NodeResizer
        isVisible={selected}
        minWidth={GROUP_MIN.width}
        minHeight={GROUP_MIN.height}
        onResize={(_, p) => setNodeSize(id, p.width, p.height, p.x, p.y)}
        onResizeEnd={() => resizeEnd()}
      />
      {/* A container names itself in a header strip, and carries the icon
          mermaid already lets it declare — `group vnet(logos:azure)[VNet]`.
          It is how draw.io labels an Azure or AWS container, and without it
          the only difference between two nested boxes was their wording. */}
      {/* Double-clicking the strip renames the container; double-clicking
          its middle is a click on the canvas inside it, which is where a new
          node goes. */}
      <div className="group-title" style={titleStyle} onDoubleClick={rename.begin}>
        {data.icon && <IconView name={data.icon} size={15} />}
        {rename.editing ? (
          rename.field
        ) : (
          <span>
            <Label text={data.label} />
          </span>
        )}
      </div>
      <SideHandles />
    </div>
  );
}
