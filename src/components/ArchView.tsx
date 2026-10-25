import { memo, useEffect, useMemo, useState } from "react";
import { type NodeProps } from "@xyflow/react";
import { C4_TAGS, type JunctionNode, type ServiceNode } from "../model/types";
import { ARCH_ICON_SIZE } from "../render/glyphSizes";
import { getIconHtml } from "../icons";
import { NodeResize } from "./NodeResize";
import { SideHandles } from "./SideHandles";
import { useRename } from "./useRename";
import { useSized } from "./useSized";

/**
 * An icon, as markup the collections hand us.
 *
 * `memo`, and the markup object kept stable, for a reason that is not about
 * speed. Re-rendering this rewrote the `<div>`'s `innerHTML`, which throws
 * away the `<svg>` inside it and builds a new one — so any re-render of a
 * grid of icons replaced every icon node in it. A pointer press that spanned
 * one of those re-renders was then never a click at all: the browser only
 * fires `click` when mousedown and mouseup land on a node that is still in
 * the document, and the node the press started on had been discarded. That
 * is what made picking an icon miss, in the picker and in the palette both.
 */
export const IconView = memo(function IconView({ name, size }: { name: string; size: number }) {
  const [html, setHtml] = useState("");
  useEffect(() => {
    let alive = true;
    void getIconHtml(name).then((svg) => {
      if (alive) setHtml(svg);
    });
    return () => {
      alive = false;
    };
  }, [name]);
  const markup = useMemo(() => ({ __html: html }), [html]);
  return (
    <div
      className="arch-icon"
      style={{ width: size, height: size }}
      dangerouslySetInnerHTML={markup}
    />
  );
});

export function ServiceNodeView({ id, data, selected }: NodeProps<ServiceNode>) {
  const sized = useSized(id);
  // One line: mermaid's architecture parser rejects `<br>` outright, so a
  // service name that held one would be a file that no longer opens.
  const rename = useRename(id, data.label);
  return (
    <div
      className={
        `service-node${selected ? " selected" : ""}${sized ? " sized" : ""}` +
        (data.style?.look === "icon" ? " bare" : "")
      }
      onDoubleClick={rename.begin}
    >
      <NodeResize id={id} visible={selected} />
      {data.icon && <IconView name={data.icon} size={ARCH_ICON_SIZE} />}
      {/* The field goes inside the label rather than in place of it: that
          element carries the type size a service name is drawn at, and a
          field standing outside it is a field of a different size — six
          pixels of node that appeared on a double-click. */}
      <div className="service-label">{rename.editing ? rename.field : data.label || id}</div>
      <SideHandles />
    </div>
  );
}

export function JunctionNodeView({ selected }: NodeProps<JunctionNode>) {
  return (
    <div className={`junction-node${selected ? " selected" : ""}`}>
      <SideHandles />
    </div>
  );
}

export function C4NodeView({ id, data, selected }: NodeProps<import("../model/types").C4Node>) {
  const external = data.c4Shape.startsWith("external_");
  const person = data.c4Shape.includes("person");
  const sized = useSized(id);
  // The name, not the description under it — that has its own field in the
  // inspector, and one double-click cannot mean two things.
  const rename = useRename(id, data.label, { multiline: true });
  return (
    <div
      className={`c4-node${external ? " external" : ""}${person ? " person" : ""}${selected ? " selected" : ""}${sized ? " sized" : ""}`}
      onDoubleClick={rename.begin}
    >
      <NodeResize id={id} visible={selected} />
      {person && <div className="c4-head" />}
      <div className="c4-tag">«{C4_TAGS[data.c4Shape] ?? data.c4Shape}»</div>
      {/* Inside the label, so the field has the label's type, not the
          browser's. */}
      <div className="c4-label">{rename.editing ? rename.field : data.label}</div>
      {data.descr && <div className="c4-descr">{data.descr}</div>}
      <SideHandles />
    </div>
  );
}
