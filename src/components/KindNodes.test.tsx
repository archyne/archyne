import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import type { NodeProps } from "@xyflow/react";
import type { RequirementNode } from "../model/types";
import { useGraphStore } from "../store";

// Outside a flow there is no React Flow store, so what the node asks of it is
// stood in for, as in `ShapeNode.test.tsx`.
vi.mock("@xyflow/react", async (actual) => ({
  ...(await actual<typeof import("@xyflow/react")>()),
  useInternalNode: () => ({ style: {} }),
  Handle: () => null,
  NodeResizer: () => null,
}));

const { RequirementNodeView } = await import("./KindNodes");

/**
 * A requirement in a class takes the class's colours. The parser takes them
 * out of the node's own `style` list — so that leaving the class does not
 * leave its colours behind — which means the view has to put them back.
 */
describe("a requirement's colours", () => {
  const draw = (data: Record<string, unknown>) => {
    const props = {
      id: "speed",
      data: { label: "speed", reqType: "requirement", direction: "TB", ...data },
      selected: false,
    } as unknown as NodeProps<RequirementNode>;
    return render(<RequirementNodeView {...props} />).container.querySelector(
      ".table-node",
    ) as HTMLElement;
  };

  it("comes from its class, under its own", () => {
    useGraphStore.setState({ classDefs: { hot: ["fill:#ff9966", "stroke:#cc3300"] } });
    const box = draw({ classes: ["hot"], styles: ["stroke:#000000"] });
    expect(box.style.background).toBe("rgb(255, 153, 102)");
    expect(box.style.borderColor).toBe("rgb(0, 0, 0)");
  });
});
