import { useRef, useState } from "react";
import { NodeResizer } from "@xyflow/react";
import { NODE_MIN, useGraphStore } from "../store";
import { contentMinSize } from "../contentSize";

/**
 * The resize handles, and the store plumbing behind them.
 *
 * Shared because every box-shaped node wants the same three things, and
 * because the split between the live half of the drag (`setNodeSize`) and
 * the commit (`onNodeDragStop`) is easy to get subtly wrong per node type.
 *
 * Not every node gets one. A junction is a dot, a fork bar is a bar, and a
 * sequence participant's geometry belongs to the overlay — resizing those
 * would mean something different, or nothing at all.
 *
 * ## Where the handles stop
 *
 * At the size where this node's own content still fits, not at a flat
 * `NODE_MIN`: dragged to 48×28 a node with an icon and a name had nowhere to
 * put either and simply cut them off. Nothing but the rendered element knows
 * how long this label is or how big its icon draws, so the floor is measured
 * from the DOM as the gesture starts.
 *
 * The two directions are held differently, because only one of them has a
 * floor of its own. The narrowest the content goes is a fixed number, so
 * width gets a hard stop and React Flow enforces it. Height has no such
 * number — how tall the content needs to be depends on how wide the box is,
 * and a label needing four lines at 54px needs one at 250 — so a height stop
 * would have to move during the drag, and moving it is not safe here:
 * `getDimensionsAfterResize` picks which way to apply a clamp from the sign
 * of the vertical travel, and on a horizontal-only drag that travel is zero,
 * so a `minHeight` that rises mid-gesture is subtracted rather than added and
 * the node comes out with a negative height.
 *
 * So height is settled on release instead: drag the box as flat as you like,
 * and if the content will not fit in it, it takes back the height it needs.
 * A snap at the end of the gesture rather than a wall during it — which also
 * leaves a wide flat box reachable, since at that width it fits.
 */
export function NodeResize({
  id,
  visible,
  picture = false,
}: {
  id: string;
  visible: boolean;
  /**
   * A picture with no frame: the box is the picture, so it keeps the
   * picture's proportions while dragged, and on release the picture takes
   * the new size and the box hugs it again.
   */
  picture?: boolean;
}) {
  const setNodeSize = useGraphStore((s) => s.setNodeSize);
  const resizeEnd = useGraphStore((s) => s.onNodeDragStop);
  const fitPictureTo = useGraphStore((s) => s.fitPictureTo);
  // Measured as the gesture starts rather than when the handles appear: that
  // is the last moment the content can still have changed, and it lands
  // before the first move, which is the first thing there is to clamp.
  const [minWidth, setMinWidth] = useState(NODE_MIN.width);
  const startY = useRef(0);

  return (
    <NodeResizer
      isVisible={visible}
      minWidth={minWidth}
      minHeight={picture ? 16 : NODE_MIN.height}
      keepAspectRatio={picture}
      onResizeStart={(_, p) => {
        startY.current = p.y;
        setMinWidth(picture ? 16 : (contentMinSize(id)?.width ?? NODE_MIN.width));
      }}
      onResize={(_, p) => setNodeSize(id, p.width, p.height, p.x, p.y)}
      onResizeEnd={(_, p) => {
        if (picture) {
          fitPictureTo(id, p.width, p.height);
          return;
        }
        const needed = contentMinSize(id, p.width)?.height ?? 0;
        if (needed > p.height) {
          // Dragging a top handle moves the origin, which means the bottom
          // edge is the one standing still — so height handed back has to go
          // on above, or the box grows down out from under the pointer.
          const fromTop = Math.abs(p.y - startY.current) > 0.5;
          setNodeSize(id, p.width, needed, p.x, fromTop ? p.y - (needed - p.height) : p.y);
        }
        resizeEnd();
      }}
    />
  );
}
