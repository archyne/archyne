import { useCallback, useRef } from "react";
import { useReactFlow } from "@xyflow/react";
import { addSeed } from "./iconPicture";
import type { NodeSeed } from "./model/types";

/**
 * Add a node without a pointer.
 *
 * The palette used to be drag-and-drop only, which meant a keyboard or
 * switch user could not put a single node on the canvas. Activating a palette
 * item now drops the node in the middle of the visible canvas instead of
 * wherever a cursor happens to be.
 */
export function useAddNodeAtCenter() {
  const { screenToFlowPosition } = useReactFlow();
  const added = useRef(0);

  return useCallback(
    (seed: NodeSeed) => {
      const rect = document.querySelector(".react-flow")?.getBoundingClientRect();
      const x = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
      const y = rect ? rect.top + rect.height / 2 : window.innerHeight / 2;
      // Stagger repeat additions so they don't stack invisibly on each other.
      const step = (added.current++ % 6) * 34;
      addSeed(seed, screenToFlowPosition({ x: x + step, y: y + step }));
    },
    [screenToFlowPosition],
  );
}
