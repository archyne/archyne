import {
  alignableSelection,
  canGroup,
  groupableSelection,
  hasCustomSize,
  sizableSelection,
  minSize,
  useGraphStore,
  type AlignEdge,
} from "../store";
import { fitToContent } from "../contentSize";
import { useT, type MessageKey } from "../i18n";
import { ImportIcon } from "./ImportIcon";
import { IconField } from "./IconPicker";
import type { RouteStyle } from "../model/edgeStyle";
import type { NodeLook } from "../model/nodeStyle";
import { useIconPrefs } from "../iconPrefs";
import { labelToText, textToLabel } from "../model/label";
import { readableOn } from "../model/importShared";
import { useId, type ReactNode } from "react";
import {
  C4_SHAPES,
  CLASS_MARKERS,
  ER_CARDS,
  ER_CARD_LABELS,
  IMG_SIZE,
  LABEL_SIZE,
  labelSize,
  SEQ_OPS,
  SEQ_OP_LABELS,
  SHAPES,
  SHAPE_LABELS,
  type AnyNode,
  type ArchDir,
  type ArrowType,
  type ClassMarker,
  type DiagramKind,
  type EdgeStroke,
  type EntityAttr,
  type ErCard,
  type FlowEdge,
  type SeqOp,
  type Shape,
} from "../model/types";

function parseAttrLine(line: string): EntityAttr | null {
  const commentMatch = line.match(/"([^"]*)"\s*$/);
  const comment = commentMatch?.[1] ?? "";
  const rest = commentMatch ? line.slice(0, commentMatch.index) : line;
  const tokens = rest
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean);
  if (tokens.length < 2) return null;
  const [type, name, ...keys] = tokens;
  return { type, name, keys: keys.map((k) => k.toUpperCase()), comment };
}

function attrToLine(a: EntityAttr): string {
  return [a.type, a.name, ...a.keys, a.comment ? `"${a.comment}"` : ""]
    .filter(Boolean)
    .join(" ");
}

/** Set or replace one `key:value` declaration in a style list. */
function withStyle(styles: string[] | undefined, key: string, value: string): string[] {
  const rest = (styles ?? []).filter((s) => !s.trim().startsWith(`${key}:`));
  return [...rest, `${key}:${value}`];
}

/** The same list with the declarations for `keys` dropped entirely. */
function withoutStyles(styles: string[] | undefined, keys: string[]): string[] {
  return (styles ?? []).filter((s) => !keys.some((k) => s.trim().startsWith(`${k}:`)));
}

/** Whether a declaration is present and says exactly `none`. */
function isNone(styles: string[] | undefined, key: string): boolean {
  const d = (styles ?? []).find((s) => s.trim().startsWith(`${key}:`));
  return d?.slice(d.indexOf(":") + 1).trim() === "none";
}

function styleValue(styles: string[] | undefined, key: string, fallback: string): string {
  const d = (styles ?? []).find((s) => s.trim().startsWith(`${key}:`));
  const v = d?.slice(d.indexOf(":") + 1).trim();
  return v && /^#[0-9a-fA-F]{6}$/.test(v) ? v : fallback;
}

/**
 * Fill and border together, a click each: draw.io's own palette, which the
 * diagrams imported from it already speak, and one dark pair for the dark
 * theme. The text colour is whichever reads on the fill.
 */
const COLOUR_PRESETS: Array<{ fill: string; stroke: string }> = [
  { fill: "#dae8fc", stroke: "#6c8ebf" },
  { fill: "#d5e8d4", stroke: "#82b366" },
  { fill: "#ffe6cc", stroke: "#d79b00" },
  { fill: "#fff2cc", stroke: "#d6b656" },
  { fill: "#f8cecc", stroke: "#b85450" },
  { fill: "#e1d5e7", stroke: "#9673a6" },
  { fill: "#f5f5f5", stroke: "#666666" },
  { fill: "#2d3748", stroke: "#718096" },
];

/** Offered inside each picker as well, where the browser shows suggestions. */
const SWATCHES = [
  ...new Set([...COLOUR_PRESETS.flatMap((p) => [p.fill, p.stroke]), "#ffffff", "#000000"]),
];

/** A node mermaid's `style <id> …` statement reaches. */
type Styled = AnyNode & { data: { styles?: string[] } };

/**
 * Whether the inspector offers this node colours: the families StyleRow is
 * shown for one node at a time, so a selection is offered exactly what each
 * of its nodes would be.
 */
function isStyled(n: AnyNode, kind: DiagramKind): n is Styled {
  return (
    n.type === "shape" ||
    n.type === "state" ||
    n.type === "entity" ||
    n.type === "class" ||
    // A flowchart subgraph takes a `style` statement as a node does; the
    // other families' containers have none to write.
    (n.type === "group" && kind === "flowchart")
  );
}

/**
 * Fill, border, text colour and type size — the `style <id> …` statement,
 * as controls.
 *
 * One component rather than one per family: mermaid takes the same statement
 * in a flowchart, a state diagram, a class diagram and an ER diagram, and a
 * colour picker that means the same thing in four places should be the same
 * colour picker. `architecture-beta` has no `style` statement at all, so a
 * service is simply not offered one.
 *
 * It takes several nodes as readily as one, so that colouring a selection
 * is these same controls rather than a second set to drift from them. Where
 * the nodes disagree the swatch is striped and says so, rather than showing
 * the first node's colour as though it were everyone's.
 */
function StyleRow({
  nodes,
  sized = true,
}: {
  nodes: Styled[];
  /** Whether its type size is offered: a container's title has none to set. */
  sized?: boolean;
}) {
  const t = useT();
  const updateNodesData = useGraphStore((s) => s.updateNodesData);
  // Dragging through a picker sends a change per pointer move; sent as one
  // gesture they are one step of undo, not a step for every colour crossed.
  const restyle = (change: (styles: string[] | undefined) => string[], burst?: string) =>
    updateNodesData(
      nodes.map((n) => [n.id, { styles: change(n.data.styles) }]),
      burst ? { burst } : undefined,
    );
  const set = (key: string, value: string) =>
    restyle((styles) => withStyle(styles, key, value), key);
  const swatches = useId();

  const shared = (key: string, fallback: string) => {
    const values = nodes.map((n) => styleValue(n.data.styles, key, fallback));
    return { value: values[0], mixed: values.some((v) => v !== values[0]) };
  };
  const colour = (key: string, label: string, fallback: string) => {
    const { value, mixed } = shared(key, fallback);
    return (
      <label>
        {label}
        {/* Read with the name, so a screen reader hears it as the stripes
            are seen: before the value, not instead of it. */}
        {mixed && <span className="visually-hidden">{t("insp.mixed")}</span>}
        <input
          type="color"
          list={swatches}
          className={mixed ? "mixed" : undefined}
          title={mixed ? t("insp.mixed") : undefined}
          value={value}
          onChange={(e) => set(key, e.target.value)}
        />
      </label>
    );
  };
  // A group's title has no type size of its own, so only the rest are asked.
  const lettered = nodes.filter((n) => n.type !== "group");
  const sizes = lettered.map((n) => labelSize(n.data.styles));
  const size = sizes.every((v) => v === sizes[0]) ? sizes[0] : undefined;

  return (
    <>
      <div className="colour-presets" role="group" aria-label={t("insp.presets")}>
        {COLOUR_PRESETS.map(({ fill, stroke }) => (
          <button
            key={fill}
            type="button"
            className="colour-preset"
            style={{ background: fill, borderColor: stroke }}
            aria-label={t("insp.preset", { fill, stroke })}
            title={`${fill} / ${stroke}`}
            onClick={() => {
              const color = readableOn(fill);
              restyle((styles) =>
                withStyle(
                  withStyle(withStyle(styles, "fill", fill), "stroke", stroke),
                  "color",
                  color ?? "#111111",
                ),
              );
            }}
          />
        ))}
      </div>
      <datalist id={swatches}>
        {SWATCHES.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
      <div className="color-row">
        {colour("fill", t("insp.fill"), "#232a3a")}
        {colour("stroke", t("insp.border"), "#5b8def")}
        {colour("color", t("insp.text"), "#e6e9f0")}
        {/* `font-size` is a label style in mermaid's own reckoning, so a
          number here is a number every reader of the file draws with.
          Back at the default it is removed rather than written out:
          12px spelled explicitly on every node is 12px nobody chose. */}
        {sized && lettered.length > 0 && (
          <label className="type-size">
            {t("insp.fontSize")}
            <input
              type="number"
              min={6}
              max={96}
              step={1}
              // Empty when the nodes disagree: any one number would be a lie.
              value={size ?? ""}
              placeholder={size === undefined ? "–" : undefined}
              title={size === undefined ? t("insp.mixed") : undefined}
              onChange={(e) => {
                const px = Number(e.target.value);
                if (!e.target.value || !Number.isFinite(px) || px <= 0) return;
                updateNodesData(
                  lettered.map((n) => [
                    n.id,
                    {
                      styles:
                        px === LABEL_SIZE
                          ? withoutStyles(n.data.styles, ["font-size"])
                          : withStyle(n.data.styles, "font-size", `${px}px`),
                    },
                  ]),
                );
              }}
            />
          </label>
        )}
        {nodes.some((n) => (n.data.styles?.length ?? 0) > 0) && (
          <button className="mini" onClick={() => restyle(() => [])}>
            {t("insp.reset")}
          </button>
        )}
      </div>
    </>
  );
}

function NodeFields({ node }: { node: AnyNode }) {
  const t = useT();
  const updateNodeData = useGraphStore((s) => s.updateNodeData);
  const setNodeStyle = useGraphStore((s) => s.setNodeStyle);
  const kind = useGraphStore((s) => s.kind);
  switch (node.type) {
    case "shape":
      return (
        <>
          <label>
            {t("insp.label")}
            {/* A textarea rather than a field: a flowchart label may be more
                than one line, `<br>` is how mermaid holds the second, and
                markup standing where a line break belongs is not something
                to type into a form. Enter makes a line here — there is
                nothing for it to submit — where the editor on the canvas
                needs Shift+Enter, Enter there being how a rename ends. */}
            <textarea
              id="inspector-label"
              className="label-field"
              rows={labelToText(node.data.label).split("\n").length}
              value={labelToText(node.data.label)}
              onChange={(e) => updateNodeData(node.id, { label: textToLabel(e.target.value) })}
            />
          </label>
          <label>
            {t("insp.shape")}
            <select
              value={node.data.shape}
              onChange={(e) => updateNodeData(node.id, { shape: e.target.value as Shape })}
            >
              {SHAPES.map((s) => (
                <option key={s} value={s}>
                  {SHAPE_LABELS[s]}
                </option>
              ))}
            </select>
          </label>
          <StyleRow nodes={[node]} />
          <label>
            CSS classes (classDef names, space-separated)
            <input
              defaultValue={(node.data.classes ?? []).join(" ")}
              onBlur={(e) =>
                updateNodeData(node.id, {
                  classes: e.target.value.split(/\s+/).filter(Boolean),
                })
              }
            />
          </label>
          <NodeImage node={node} />
          <NodeSize node={node} />
        </>
      );
    case "state":
      return node.data.stateType === "normal" ? (
        <>
          <label>
            {t("insp.label")}
            <input
              value={node.data.label}
              onChange={(e) => updateNodeData(node.id, { label: e.target.value })}
            />
          </label>
          <StyleRow nodes={[node]} />
          <NodeSize node={node} />
        </>
      ) : (
        <div className="inspector-empty">
          {t("insp.pseudoState", { type: node.data.stateType })}
        </div>
      );
    case "entity":
      return (
        <>
          <label>
            {t("insp.name")}
            <input
              id="inspector-label"
              value={node.data.label}
              onChange={(e) => updateNodeData(node.id, { label: e.target.value })}
            />
          </label>
          <label>
            {t("insp.attributes")} <code>type name PK &quot;comment&quot;</code>
            <textarea
              rows={Math.max(3, node.data.attributes.length + 1)}
              defaultValue={node.data.attributes.map(attrToLine).join("\n")}
              onBlur={(e) =>
                updateNodeData(node.id, {
                  attributes: e.target.value
                    .split("\n")
                    .map(parseAttrLine)
                    .filter((a): a is EntityAttr => a !== null),
                })
              }
            />
          </label>
          <StyleRow nodes={[node]} />
          <NodeSize node={node} />
        </>
      );
    case "service":
      return (
        <>
          <label>
            {t("insp.label")}
            <input
              id="inspector-label"
              value={node.data.label}
              onChange={(e) => updateNodeData(node.id, { label: e.target.value })}
            />
          </label>
          <label>
            {t("insp.icon")}
            <input
              // Re-mounted when the icon changes, so a pick from the picker
              // shows here too: the field is uncontrolled on purpose, to
              // leave half-typed references alone until the blur.
              key={`ni-${node.id}-${node.data.icon ?? ""}`}
              defaultValue={node.data.icon}
              onBlur={(e) => {
                const icon = e.target.value.trim();
                if (icon) useIconPrefs.getState().recordRecent(icon);
                updateNodeData(node.id, { icon });
              }}
            />
          </label>
          <div className="icon-actions">
            <IconField
              value={node.data.icon}
              onChange={(icon) => updateNodeData(node.id, { icon })}
            />
            <ImportIcon nodeId={node.id} />
          </div>
          <label>
            {t("insp.look")}
            <select
              value={node.data.style?.look ?? "boxed"}
              onChange={(e) => setNodeStyle(node.id, { look: e.target.value as NodeLook })}
            >
              <option value="boxed">{t("insp.lookBoxed")}</option>
              <option value="icon">{t("insp.lookIcon")}</option>
            </select>
          </label>
          <NodeSize node={node} />
        </>
      );
    case "junction":
      return <div className="inspector-empty">{t("insp.junction")}</div>;
    case "note":
      return (
        <>
          <label>
            {t("insp.text")}
            <textarea
              id="inspector-label"
              key={node.id}
              rows={3}
              defaultValue={node.data.text}
              onBlur={(e) => updateNodeData(node.id, { text: e.target.value })}
            />
          </label>
          <label>
            Attached to (class name, optional)
            <input
              key={`t-${node.id}`}
              defaultValue={node.data.target ?? ""}
              onBlur={(e) =>
                updateNodeData(node.id, { target: e.target.value.trim() || undefined })
              }
            />
          </label>
          <NodeSize node={node} />
        </>
      );
    case "c4":
      return (
        <>
          <label>
            {t("insp.label")}
            <input
              id="inspector-label"
              value={node.data.label}
              onChange={(e) => updateNodeData(node.id, { label: e.target.value })}
            />
          </label>
          <label>
            {t("insp.elementType")}
            <select
              value={node.data.c4Shape}
              onChange={(e) => updateNodeData(node.id, { c4Shape: e.target.value })}
            >
              {C4_SHAPES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("insp.description")}
            <textarea
              rows={2}
              defaultValue={node.data.descr}
              onBlur={(e) => updateNodeData(node.id, { descr: e.target.value.trim() })}
            />
          </label>
          <NodeSize node={node} />
        </>
      );
    case "participant":
      return (
        <>
          <label>
            {t("insp.name")}
            <input
              id="inspector-label"
              value={node.data.label}
              onChange={(e) => updateNodeData(node.id, { label: e.target.value })}
            />
          </label>
          <label>
            {t("insp.kind")}
            <select
              value={node.data.ptype}
              onChange={(e) => updateNodeData(node.id, { ptype: e.target.value })}
            >
              <option value="participant">{t("insp.participantBox")}</option>
              <option value="actor">{t("insp.actorPerson")}</option>
            </select>
          </label>
        </>
      );
    case "class":
      return (
        <>
          <label>
            {t("insp.name")}
            <input
              id="inspector-label"
              value={node.data.label}
              onChange={(e) => updateNodeData(node.id, { label: e.target.value })}
            />
          </label>
          <label>
            Fields — one per line: <code>+int age</code>
            <textarea
              rows={Math.max(2, node.data.members.length + 1)}
              defaultValue={node.data.members.join("\n")}
              onBlur={(e) =>
                updateNodeData(node.id, {
                  members: e.target.value
                    .split("\n")
                    .map((l) => l.trim())
                    .filter(Boolean),
                })
              }
            />
          </label>
          <label>
            {t("insp.annotations")} <code>interface</code> {t("insp.annotationsHint")}
            <input
              defaultValue={(node.data.annotations ?? []).join(" ")}
              onBlur={(e) =>
                updateNodeData(node.id, {
                  annotations: e.target.value.split(/s+/).filter(Boolean),
                })
              }
            />
          </label>
          <label>
            Generic parameter — e.g. <code>T</code>
            <input
              defaultValue={node.data.generic ?? ""}
              onBlur={(e) =>
                updateNodeData(node.id, { generic: e.target.value.trim() || undefined })
              }
            />
          </label>
          <label>
            Methods — one per line: <code>+run() void</code>
            <textarea
              rows={Math.max(2, node.data.methods.length + 1)}
              defaultValue={node.data.methods.join("\n")}
              onBlur={(e) =>
                updateNodeData(node.id, {
                  methods: e.target.value
                    .split("\n")
                    .map((l) => l.trim())
                    .filter(Boolean),
                })
              }
            />
          </label>
          <StyleRow nodes={[node]} />
          <NodeSize node={node} />
        </>
      );
    case "group":
      return (
        <>
          <label>
            {t("insp.label")}
            <input
              id="inspector-label"
              value={String(node.data.label)}
              onChange={(e) => updateNodeData(node.id, { label: e.target.value })}
            />
          </label>
          {/* A container may carry an icon exactly as a service does — it is
              in mermaid's syntax already — and the field was simply missing
              here, so the only way to set one was to type it in the source. */}
          <label>
            {t("insp.icon")}
            <input
              key={`gi-${node.id}-${node.data.icon ?? ""}`}
              defaultValue={node.data.icon ?? ""}
              onBlur={(e) => {
                const icon = e.target.value.trim();
                if (icon) useIconPrefs.getState().recordRecent(icon);
                updateNodeData(node.id, { icon });
              }}
            />
          </label>
          <div className="icon-actions">
            <IconField
              value={node.data.icon}
              onChange={(icon) => updateNodeData(node.id, { icon })}
            />
            <ImportIcon nodeId={node.id} />
          </div>
          <label>
            {t("insp.look")}
            <select
              value={node.data.style?.look ?? "boxed"}
              onChange={(e) => setNodeStyle(node.id, { look: e.target.value as NodeLook })}
            >
              <option value="boxed">{t("insp.lookDashed")}</option>
              <option value="solid">{t("insp.lookSolid")}</option>
              <option value="plain">{t("insp.lookPlain")}</option>
            </select>
          </label>
          {isStyled(node, kind) && <StyleRow nodes={[node]} sized={false} />}
          <NodeSize node={node} />
        </>
      );
    default:
      // Every member of the union is handled above — TypeScript narrows
      // `node` to `never` here — so this only guards a kind added later
      // without a branch, and does it by showing nothing rather than by
      // reading fields that may not exist.
      return null;
  }
}

/** The two declarations that take mermaid's frame off a picture. */
function withoutFrame(styles: string[] | undefined): string[] {
  return withStyle(withStyle(styles, "fill", "none"), "stroke", "none");
}

/**
 * A picture on a flowchart node, as a URL.
 *
 * This is the one icon form that survives leaving Archyne: every other kind
 * names a pack the reader must already have, and the official Mermaid Live
 * Editor registers none — so `logos:aws` draws a "?" there while this draws
 * the logo. Hence the picker writes a URL here rather than a name, and the
 * hint says what the trade is.
 */
function NodeImage({ node }: { node: AnyNode & { type: "shape" } }) {
  const t = useT();
  const updateNodeData = useGraphStore((s) => s.updateNodeData);
  const { img, imgPos, imgWidth, styles } = node.data;
  const frameless = isNone(styles, "fill") && isNone(styles, "stroke");

  /**
   * An icon is a picture, not a box with a picture in it, so taking one on
   * takes the frame off and taking it away puts the frame back.
   *
   * Only on the change, never on every edit: a frame switched back on by
   * hand must survive the next thing done to the node. And written as real
   * `fill:none,stroke:none` rather than a private flag, so the file says the
   * same thing to mermaid as it does to us — mermaid draws its frame tight
   * around the picture from exactly these two values.
   */
  const setPicture = (url: string | undefined) => {
    const patch: Record<string, unknown> = { img: url };
    if (url && !img) patch.styles = withoutFrame(styles);
    if (!url && frameless) patch.styles = withoutStyles(styles, ["fill", "stroke"]);
    updateNodeData(node.id, patch);
  };

  return (
    <>
      <label>
        {t("insp.image")}
        <input
          key={`img-${node.id}-${img ?? ""}`}
          defaultValue={img ?? ""}
          placeholder="https://api.iconify.design/logos/aws.svg"
          onBlur={(e) => setPicture(e.target.value.trim() || undefined)}
        />
      </label>
      <div className="size-row">
        <IconField value={img} asImage onChange={(url) => setPicture(url || undefined)} />
        {img && (
          <>
            <label>
              {t("insp.imagePos")}
              <select
                value={imgPos ?? "b"}
                onChange={(e) =>
                  updateNodeData(node.id, { imgPos: e.target.value as "t" | "b" })
                }
              >
                <option value="b">{t("insp.imagePosBelow")}</option>
                <option value="t">{t("insp.imagePosAbove")}</option>
              </select>
            </label>
            <label>
              {t("insp.imageSize")}
              <input
                type="number"
                min={8}
                max={400}
                value={imgWidth ?? IMG_SIZE}
                onChange={(e) => {
                  const size = Number(e.target.value);
                  if (!Number.isFinite(size) || size <= 0) return;
                  // One number: an icon is square in every set worth using,
                  // and two fields to keep in step is two chances to skew it.
                  updateNodeData(node.id, { imgWidth: size, imgHeight: size });
                }}
              />
            </label>
          </>
        )}
      </div>
      {img && (
        <>
          {/* The same question a service is asked, in the same words: a box
              with the icon in it, or the icon alone. What the file gets
              differs — `fill:none,stroke:none` here, `look` in the graph
              comment there — because `architecture-beta` has no `style`
              statement to write. The choice is the user's either way, and
              it should not read as two different choices. */}
          <label>
            {t("insp.look")}
            <select
              value={frameless ? "icon" : "boxed"}
              onChange={(e) =>
                updateNodeData(node.id, {
                  styles:
                    e.target.value === "icon"
                      ? withoutFrame(styles)
                      : withoutStyles(styles, ["fill", "stroke"]),
                })
              }
            >
              <option value="boxed">{t("insp.lookBoxed")}</option>
              <option value="icon">{t("insp.lookIcon")}</option>
            </select>
          </label>
          <p className="field-hint">{t("insp.imageHint")}</p>
        </>
      )}
    </>
  );
}

/**
 * Width and height in numbers, for the nodes that can take one.
 *
 * The resize handles are a dragging gesture, and WCAG 2.5.7 asks for the
 * same functionality without one. Typing a size is also the only way to make
 * two boxes exactly equal, which dragging never quite manages.
 */
function NodeSize({ node }: { node: AnyNode }) {
  const t = useT();
  const resizeNode = useGraphStore((s) => s.resizeNode);
  const resetNodeSize = useGraphStore((s) => s.resetNodeSize);
  const min = minSize(node);
  const width = Math.round(Number(node.style?.width ?? node.measured?.width ?? min.width));
  const height = Math.round(Number(node.style?.height ?? node.measured?.height ?? min.height));

  /**
   * Raised to fit, against a measurement taken now: typing a size must stop
   * where dragging a handle stops, or the two controls for one property
   * disagree — and the label may have grown since the panel opened.
   */
  const apply = (w: number, h: number) => {
    const fit = fitToContent(node.id, { width: w, height: h }, min);
    resizeNode(node.id, fit.width, fit.height);
  };

  return (
    <div className="size-row">
      <label>
        {t("insp.width")}
        <input
          type="number"
          min={min.width}
          step={10}
          value={width}
          onChange={(e) => apply(Number(e.target.value), height)}
        />
      </label>
      <label>
        {t("insp.height")}
        <input
          type="number"
          min={min.height}
          step={10}
          value={height}
          onChange={(e) => apply(width, Number(e.target.value))}
        />
      </label>
      {hasCustomSize(node) && (
        <button className="mini" onClick={() => resetNodeSize(node.id)}>
          {t("insp.autoSize")}
        </button>
      )}
    </div>
  );
}

function EdgeFields({ edge }: { edge: FlowEdge }) {
  const t = useT();
  const updateEdgeData = useGraphStore((s) => s.updateEdgeData);
  const setEdgeStyle = useGraphStore((s) => s.setEdgeStyle);
  const moveMessage = useGraphStore((s) => s.moveMessage);
  const d = edge.data;
  if (!d) return null;

  return (
    <>
      <label>
        {t("insp.label")}
        <input
          id="inspector-label"
          value={d.label}
          onChange={(e) => updateEdgeData(edge.id, { label: e.target.value })}
        />
      </label>
      {d.seq && (
        <>
          <label>
            {t("insp.arrow")}
            <select
              value={d.seq.op}
              onChange={(e) =>
                updateEdgeData(edge.id, { seq: { op: e.target.value as SeqOp } })
              }
            >
              {SEQ_OPS.map((op) => (
                <option key={op} value={op}>
                  {op} — {SEQ_OP_LABELS[op]}
                </option>
              ))}
            </select>
          </label>
          <div className="color-row">
            <button className="mini" onClick={() => moveMessage(edge.id, -1)}>
              ↑ Move up
            </button>
            <button className="mini" onClick={() => moveMessage(edge.id, 1)}>
              ↓ Move down
            </button>
          </div>
        </>
      )}
      {d.stroke !== undefined && (
        <>
          <label>
            {t("insp.line")}
            <select
              value={d.stroke}
              onChange={(e) =>
                updateEdgeData(edge.id, { stroke: e.target.value as EdgeStroke })
              }
            >
              <option value="normal">{t("insp.lineSolid")}</option>
              <option value="dotted">{t("insp.lineDotted")}</option>
              <option value="thick">{t("insp.lineThick")}</option>
            </select>
          </label>
          <label>
            {t("insp.routing")}
            <select
              value={edge.data?.style?.route ?? "orthogonal"}
              onChange={(e) => setEdgeStyle(edge.id, { route: e.target.value as RouteStyle })}
            >
              <option value="orthogonal">{t("insp.routeOrthogonal")}</option>
              <option value="straight">{t("insp.routeStraight")}</option>
              <option value="curved">{t("insp.routeCurved")}</option>
            </select>
          </label>
          <label>
            {t("insp.arrow")}
            <select
              value={d.arrow}
              onChange={(e) => updateEdgeData(edge.id, { arrow: e.target.value as ArrowType })}
            >
              <option value="arrow_point">{t("insp.arrowPoint")}</option>
              <option value="arrow_open">{t("insp.arrowNone")}</option>
              <option value="arrow_circle">{t("insp.arrowCircle")}</option>
              <option value="arrow_cross">{t("insp.arrowCross")}</option>
            </select>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={Boolean(d.both)}
              onChange={(e) => updateEdgeData(edge.id, { both: e.target.checked })}
            />
            {t("insp.bothEnds")}
          </label>
        </>
      )}
      {d.er && (
        <>
          <label>
            {edge.source} side
            <select
              value={d.er.cardB}
              onChange={(e) =>
                updateEdgeData(edge.id, { er: { ...d.er!, cardB: e.target.value as ErCard } })
              }
            >
              {ER_CARDS.map((c) => (
                <option key={c} value={c}>
                  {ER_CARD_LABELS[c]}
                </option>
              ))}
            </select>
          </label>
          <label>
            {edge.target} side
            <select
              value={d.er.cardA}
              onChange={(e) =>
                updateEdgeData(edge.id, { er: { ...d.er!, cardA: e.target.value as ErCard } })
              }
            >
              {ER_CARDS.map((c) => (
                <option key={c} value={c}>
                  {ER_CARD_LABELS[c]}
                </option>
              ))}
            </select>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={d.er.identifying}
              onChange={(e) =>
                updateEdgeData(edge.id, { er: { ...d.er!, identifying: e.target.checked } })
              }
            />
            {t("insp.identifying")}
          </label>
        </>
      )}
      {d.c4 && (
        <>
          <label>
            {t("insp.technology")}
            <input
              value={d.c4.techn}
              placeholder={t("insp.techPlaceholder")}
              onChange={(e) =>
                updateEdgeData(edge.id, { c4: { ...d.c4!, techn: e.target.value } })
              }
            />
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={d.c4.relType === "birel"}
              onChange={(e) =>
                updateEdgeData(edge.id, {
                  c4: { ...d.c4!, relType: e.target.checked ? "birel" : "rel" },
                })
              }
            />
            {t("insp.bidirectional")}
          </label>
        </>
      )}
      {d.arch && (
        <>
          <label>
            Side at {edge.source}
            <select
              value={d.arch.lhsDir}
              onChange={(e) =>
                updateEdgeData(edge.id, {
                  arch: { ...d.arch!, lhsDir: e.target.value as ArchDir },
                })
              }
            >
              {(["L", "R", "T", "B"] as const).map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label>
            Side at {edge.target}
            <select
              value={d.arch.rhsDir}
              onChange={(e) =>
                updateEdgeData(edge.id, {
                  arch: { ...d.arch!, rhsDir: e.target.value as ArchDir },
                })
              }
            >
              {(["L", "R", "T", "B"] as const).map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={d.arch.rhsInto}
              onChange={(e) =>
                updateEdgeData(edge.id, { arch: { ...d.arch!, rhsInto: e.target.checked } })
              }
            />
            Arrow into {edge.target}
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={d.arch.lhsInto}
              onChange={(e) =>
                updateEdgeData(edge.id, { arch: { ...d.arch!, lhsInto: e.target.checked } })
              }
            />
            Arrow into {edge.source}
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={d.arch.lhsGroup}
              onChange={(e) =>
                updateEdgeData(edge.id, { arch: { ...d.arch!, lhsGroup: e.target.checked } })
              }
            />
            Attach at {edge.source}'s group border
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={d.arch.rhsGroup}
              onChange={(e) =>
                updateEdgeData(edge.id, { arch: { ...d.arch!, rhsGroup: e.target.checked } })
              }
            />
            Attach at {edge.target}'s group border
          </label>
        </>
      )}
      {d.cls && (
        <>
          <label>
            Marker at {edge.source}
            <select
              value={d.cls.left}
              onChange={(e) =>
                updateEdgeData(edge.id, {
                  cls: { ...d.cls!, left: e.target.value as ClassMarker },
                })
              }
            >
              {CLASS_MARKERS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <label>
            Marker at {edge.target}
            <select
              value={d.cls.right}
              onChange={(e) =>
                updateEdgeData(edge.id, {
                  cls: { ...d.cls!, right: e.target.value as ClassMarker },
                })
              }
            >
              {CLASS_MARKERS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={d.cls.dotted}
              onChange={(e) =>
                updateEdgeData(edge.id, { cls: { ...d.cls!, dotted: e.target.checked } })
              }
            />
            {t("insp.dottedLine")}
          </label>
          <label>
            Cardinality at {edge.source}
            <input
              value={d.cls.card1 ?? ""}
              placeholder={t("insp.cardOnePlaceholder")}
              onChange={(e) =>
                updateEdgeData(edge.id, {
                  cls: { ...d.cls!, card1: e.target.value || undefined },
                })
              }
            />
          </label>
          <label>
            Cardinality at {edge.target}
            <input
              value={d.cls.card2 ?? ""}
              placeholder={t("insp.cardManyPlaceholder")}
              onChange={(e) =>
                updateEdgeData(edge.id, {
                  cls: { ...d.cls!, card2: e.target.value || undefined },
                })
              }
            />
          </label>
        </>
      )}
    </>
  );
}

export function Inspector() {
  const t = useT();
  const nodes = useGraphStore((s) => s.nodes);
  const edges = useGraphStore((s) => s.edges);

  const node = nodes.find((n) => n.selected);
  const edge = edges.find((e) => e.selected);
  const selectedCount = nodes.filter((n) => n.selected).length;

  // With several nodes selected the panel used to show the fields of
  // whichever happened to be first, which is misleading — editing them
  // silently affected one node out of five. Arranging the selection is the
  // thing that actually applies to all of them.
  if (selectedCount > 1) {
    return (
      <section className="inspector">
        <div className="panel-title">
          {t("insp.selection", { count: String(selectedCount) })}
        </div>
        <SelectionFields nodes={nodes} />
      </section>
    );
  }

  if (node) {
    return (
      <section className="inspector">
        <div className="panel-title">
          {node.type === "group"
            ? t("insp.groupTitle", { id: node.id })
            : t("insp.nodeTitle", { id: node.id })}
        </div>
        <NodeFields node={node} />
      </section>
    );
  }
  if (edge) {
    return (
      <section className="inspector">
        <div className="panel-title">
          {t("insp.edgeTitle", { source: edge.source, target: edge.target })}
        </div>
        <EdgeFields edge={edge} />
      </section>
    );
  }
  return <DiagramMeta />;
}

/** Diagram-level properties, shown when nothing is selected. */
function DiagramMeta() {
  const t = useT();
  const kind = useGraphStore((s) => s.kind);
  const title = useGraphStore((s) => s.title);
  const accTitle = useGraphStore((s) => s.accTitle);
  const accDescr = useGraphStore((s) => s.accDescr);
  const setDiagramMeta = useGraphStore((s) => s.setDiagramMeta);

  return (
    <section className="inspector">
      <div className="panel-title">{t("insp.diagramTitle")}</div>
      {kind === "c4" && (
        <label>
          {t("insp.title")}
          <input
            defaultValue={title}
            key={`t-${title}`}
            onBlur={(e) => setDiagramMeta({ title: e.target.value.trim() })}
          />
        </label>
      )}
      <label>
        {t("inspector.accTitle")}
        <input
          defaultValue={accTitle}
          key={`at-${accTitle}`}
          onBlur={(e) => setDiagramMeta({ accTitle: e.target.value.trim() })}
        />
      </label>
      <label>
        {t("inspector.accDescr")}
        <textarea
          rows={2}
          defaultValue={accDescr}
          key={`ad-${accDescr}`}
          onBlur={(e) => setDiagramMeta({ accDescr: e.target.value.trim() })}
        />
      </label>
      <div className="inspector-empty">{t("inspector.empty")}</div>
    </section>
  );
}

/** The align commands, in the two sets of three the panel shows them in. */
const ALIGN: Array<[AlignEdge, MessageKey]> = [
  ["left", "insp.alignLeft"],
  ["centerX", "insp.alignCenterX"],
  ["right", "insp.alignRight"],
  ["top", "insp.alignTop"],
  ["middleY", "insp.alignMiddleY"],
  ["bottom", "insp.alignBottom"],
];

/**
 * A picture of each command: the line the edges meet on, and two bars of
 * different lengths meeting it. A word on the button said "Left" and left
 * open which left — the edges lining up on one vertical line, or the row
 * sliding over — and the first reading stacks a row of icons into one box.
 */
const ARRANGE_ICON: Record<AlignEdge | "x" | "y", ReactNode> = {
  left: (
    <>
      <path d="M4 3v18" />
      <rect x="7" y="6" width="12" height="4" rx="1" />
      <rect x="7" y="14" width="7" height="4" rx="1" />
    </>
  ),
  centerX: (
    <>
      <path d="M12 3v18" />
      <rect x="5" y="6" width="14" height="4" rx="1" />
      <rect x="8" y="14" width="8" height="4" rx="1" />
    </>
  ),
  right: (
    <>
      <path d="M20 3v18" />
      <rect x="5" y="6" width="12" height="4" rx="1" />
      <rect x="10" y="14" width="7" height="4" rx="1" />
    </>
  ),
  top: (
    <>
      <path d="M3 4h18" />
      <rect x="6" y="7" width="4" height="12" rx="1" />
      <rect x="14" y="7" width="4" height="7" rx="1" />
    </>
  ),
  middleY: (
    <>
      <path d="M3 12h18" />
      <rect x="6" y="5" width="4" height="14" rx="1" />
      <rect x="14" y="8" width="4" height="8" rx="1" />
    </>
  ),
  bottom: (
    <>
      <path d="M3 20h18" />
      <rect x="6" y="5" width="4" height="12" rx="1" />
      <rect x="14" y="10" width="4" height="7" rx="1" />
    </>
  ),
  // Equal gaps: the outer two stay put and the middle one sits between.
  x: (
    <>
      <path d="M3 4v16M21 4v16" />
      <rect x="9.5" y="7" width="5" height="10" rx="1" />
    </>
  ),
  y: (
    <>
      <path d="M4 3h16M4 21h16" />
      <rect x="7" y="9.5" width="10" height="5" rx="1" />
    </>
  ),
};

/** Two bars made one length, with the measure they now share beside them. */
const SIZE_ICON: Record<"width" | "height", ReactNode> = {
  width: (
    <>
      <rect x="4" y="4" width="16" height="5" rx="1" />
      <rect x="4" y="11" width="16" height="5" rx="1" />
      <path d="M4 20h16M4 18v4M20 18v4" />
    </>
  ),
  height: (
    <>
      <rect x="4" y="4" width="5" height="16" rx="1" />
      <rect x="11" y="4" width="5" height="16" rx="1" />
      <path d="M20 4v16M18 4h4M18 20h4" />
    </>
  ),
};

/**
 * Arranging a multi-selection: align on an edge, or even out the gaps.
 *
 * Dragging gets two boxes nearly level; arithmetic gets them level. These
 * are also the way to arrange a diagram without dragging anything, which is
 * the same reason a group's size can be typed.
 */
function SelectionFields({ nodes }: { nodes: AnyNode[] }) {
  const t = useT();
  const kind = useGraphStore((s) => s.kind);
  const alignSelection = useGraphStore((s) => s.alignSelection);
  const distributeSelection = useGraphStore((s) => s.distributeSelection);
  const matchSelectionSize = useGraphStore((s) => s.matchSelectionSize);
  const groupSelection = useGraphStore((s) => s.groupSelection);

  const targets = alignableSelection(nodes);
  const canAlign = targets.length >= 2;
  const canDistribute = targets.length >= 3;
  const canSize = kind !== "sequence" && sizableSelection(nodes).length >= 2;
  // Grouping lived only in the right-click menu, where nobody who did not
  // already know it was there would look.
  const members = canGroup(kind) ? groupableSelection(nodes) : [];
  const selected = nodes.filter((n) => n.selected);
  const styled = selected.filter((n) => isStyled(n, kind));

  // The name goes in the tooltip as well as to a screen reader: with only a
  // picture on the button, hovering is how a sighted user reads it.
  const tool = (
    id: string,
    label: string,
    icon: ReactNode,
    disabled: boolean,
    run: () => void,
  ) => (
    <button
      key={id}
      type="button"
      className="arrange-tool"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={run}
    >
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        {icon}
      </svg>
    </button>
  );
  const alignTool = ([edge, key]: [AlignEdge, MessageKey]) =>
    tool(edge, `${t("insp.align")}: ${t(key)}`, ARRANGE_ICON[edge], !canAlign, () =>
      alignSelection(edge),
    );
  const distributeTool = (axis: "x" | "y", key: MessageKey) =>
    tool(axis, `${t("insp.distribute")}: ${t(key)}`, ARRANGE_ICON[axis], !canDistribute, () =>
      distributeSelection(axis),
    );
  const sizeTool = (dim: "width" | "height", key: MessageKey) =>
    tool(dim, t(key), SIZE_ICON[dim], !canSize, () => matchSelectionSize(dim));

  return (
    <>
      <div className="arrange">
        <div className="arrange-block" role="group" aria-label={t("insp.align")}>
          <div className="arrange-label">{t("insp.align")}</div>
          <div className="arrange-sets">
            <div className="arrange-set">{ALIGN.slice(0, 3).map(alignTool)}</div>
            <div className="arrange-set">{ALIGN.slice(3).map(alignTool)}</div>
          </div>
        </div>
        <div className="arrange-block" role="group" aria-label={t("insp.distribute")}>
          <div className="arrange-label">{t("insp.distribute")}</div>
          <div className="arrange-set">
            {distributeTool("x", "insp.distributeX")}
            {distributeTool("y", "insp.distributeY")}
          </div>
        </div>
        <div className="arrange-block" role="group" aria-label={t("insp.size")}>
          <div className="arrange-label">{t("insp.size")}</div>
          <div className="arrange-set">
            {sizeTool("width", "insp.matchWidth")}
            {sizeTool("height", "insp.matchHeight")}
          </div>
        </div>
      </div>

      {members.length > 0 && (
        <div className="arrange-actions">
          <button type="button" className="mini" onClick={groupSelection}>
            {t("menu.groupNodes", { count: members.length })}
          </button>
        </div>
      )}

      {styled.length > 0 && (
        <>
          <div className="field-hint arrange-heading">{t("insp.presets")}</div>
          <StyleRow nodes={styled} />
          {/* A note or a start state takes no style; say so rather than
              letting a colour apply to four of five and leave the fifth
              looking forgotten. */}
          {styled.length < selected.length && (
            <p className="field-hint">
              {t("insp.styleSome", {
                count: String(styled.length),
                total: String(selected.length),
              })}
            </p>
          )}
        </>
      )}

      {/* Say why, rather than leaving dead buttons to be puzzled over. */}
      {!canAlign && <p className="field-hint">{t("insp.alignSameParent")}</p>}
      {canAlign && !canDistribute && (
        <p className="field-hint">{t("insp.distributeNeedsThree")}</p>
      )}
    </>
  );
}
