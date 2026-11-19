import { type NodeProps } from "@xyflow/react";
import { Label } from "./Label";
import type { ClassNode, EntityNode, StateNode } from "../model/types";
import { NodeResize } from "./NodeResize";
import { useSized } from "./useSized";

import { SideHandles } from "./SideHandles";
import { useRename } from "./useRename";
import { boxStyleOf, labelStyleOf, readableLabel, styleProps } from "../model/nodeStyle";
import { edgeColors, useThemeStore } from "../theme";
import { markerDefs } from "../render/markers";

export function StateNodeView({ id, data, selected }: NodeProps<StateNode>) {
  if (data.stateType === "choice") {
    return (
      <div className={`choice-state${selected ? " selected" : ""}`}>
        <SideHandles />
      </div>
    );
  }
  if (data.stateType === "fork" || data.stateType === "join") {
    return (
      <div className={`forkjoin-state${selected ? " selected" : ""}`}>
        <SideHandles />
      </div>
    );
  }
  if (data.stateType !== "normal") {
    return (
      <div className={`pseudo-state ${data.stateType}${selected ? " selected" : ""}`}>
        {data.stateType === "end" && <div className="pseudo-inner" />}
        <SideHandles />
      </div>
    );
  }
  // Only ordinary states resize. A choice diamond, a fork bar and the start
  // and end markers are notation with a fixed meaning, not boxes.
  return <NormalState id={id} data={data} selected={selected} />;
}

/** An ordinary state: a box with a name, and the name can be typed into. */
function NormalState({
  id,
  data,
  selected,
}: {
  id: string;
  data: StateNode["data"];
  selected: boolean;
}) {
  const rename = useRename(id, data.label, {
    multiline: true,
    style: labelStyleOf(readableLabel(styleProps(data.styles ?? []))),
  });
  return (
    <SizedBox
      id={id}
      className="state-node"
      selected={selected}
      styles={data.styles}
      onDoubleClick={rename.begin}
    >
      {rename.editing ? rename.field : <Label text={data.label} />}
      <SideHandles />
    </SizedBox>
  );
}

/**
 * A node that fills the size it was given, and offers handles for changing
 * it. Without `sized` these boxes are as big as their content, between a
 * floor and (for some) a ceiling that would otherwise refuse the resize.
 */
function SizedBox({
  id,
  className,
  selected,
  children,
  onDoubleClick,
  styles,
}: {
  id: string;
  className: string;
  selected: boolean;
  children: React.ReactNode;
  onDoubleClick?: (e: React.MouseEvent) => void;
  /** The node's own `style` declarations, as far as they can be drawn. */
  styles?: string[];
}) {
  const sized = useSized(id);
  return (
    <div
      className={`${className}${selected ? " selected" : ""}${sized ? " sized" : ""}`}
      style={boxStyleOf(readableLabel(styleProps(styles ?? [])))}
      onDoubleClick={onDoubleClick}
    >
      <NodeResize id={id} visible={selected} />
      {children}
    </div>
  );
}

export function EntityNodeView({ id, data, selected }: NodeProps<EntityNode>) {
  // The title only: the rows below it are attributes with a syntax of their
  // own, and the inspector is where those are edited.
  const rename = useRename(id, data.label, { multiline: true });
  return (
    <SizedBox id={id} className="table-node" selected={selected} styles={data.styles}>
      <div className="table-title" onDoubleClick={rename.begin}>
        {rename.editing ? rename.field : <Label text={data.label} />}
      </div>
      {data.attributes.length > 0 && (
        <div className="table-rows">
          {data.attributes.map((a, i) => (
            <div key={i} className="table-row">
              <span className="dim">{a.type}</span>
              <span>{a.name}</span>
              <span className="keys">{a.keys.join(",")}</span>
            </div>
          ))}
        </div>
      )}
      <SideHandles />
    </SizedBox>
  );
}

export function ClassNodeView({ id, data, selected }: NodeProps<ClassNode>) {
  // The class name, not the members and methods beneath it — those have a
  // syntax the inspector's textarea already takes.
  const rename = useRename(id, data.label, { multiline: true });
  return (
    <SizedBox id={id} className="table-node" selected={selected} styles={data.styles}>
      <div className="table-title" onDoubleClick={rename.begin}>
        {(data.annotations ?? []).map((a) => (
          <div key={a} className="class-annotation">
            «{a}»
          </div>
        ))}
        {rename.editing ? rename.field : <Label text={data.label} />}
        {data.generic ? `<${data.generic}>` : ""}
      </div>
      {data.members.length > 0 && (
        <div className="table-rows">
          {data.members.map((m, i) => (
            <div key={i} className="table-row mono">
              {m}
            </div>
          ))}
        </div>
      )}
      {data.methods.length > 0 && (
        <div className="table-rows">
          {data.methods.map((m, i) => (
            <div key={i} className="table-row mono">
              {m}
            </div>
          ))}
        </div>
      )}
      <SideHandles />
    </SizedBox>
  );
}

/**
 * SVG marker definitions for UML and crow's-foot arrowheads, referenced by
 * edges via `url(#id)`. Rendered once inside the canvas.
 */
export function MarkerDefs() {
  // Subscribed rather than read once: the markers are painted with literal
  // colours, so they have to be redrawn when the theme flips.
  useThemeStore((s) => s.resolved);
  const { stroke, hollowFill } = edgeColors();
  // The canvas adapter over `render/markers.ts`. The eleven definitions live
  // there so the SVG renderer emits the same crow's foot this draws; all that
  // is left here is handing them the theme's two colours and letting React
  // insert the result. `dangerouslySetInnerHTML` is the only way to put an
  // already-serialised SVG subtree into the tree, and what goes in is built
  // from a table in this repository with no input from a document.
  return (
    <svg style={{ position: "absolute", width: 0, height: 0 }}>
      <defs dangerouslySetInnerHTML={{ __html: markerDefs(stroke, hollowFill) }} />
    </svg>
  );
}
