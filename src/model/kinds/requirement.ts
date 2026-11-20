import type {
  AnyNode,
  ClassDefs,
  Direction,
  FlowEdge,
  ReqRelation,
  ReqRisk,
  ReqType,
  ReqVerify,
  RequirementNode,
} from "../types";
import { REQ_RELATIONS } from "../types";
import { entriesOf } from "./shared";

/**
 * SysML requirement diagrams, as mermaid's `requirementDiagram` writes them.
 *
 * The one part of SysML mermaid draws natively. Its other diagrams map onto
 * families Archyne already edits — a block definition diagram is a class
 * diagram of «block»s, a state machine is a state diagram — so they arrive
 * as templates rather than as families of their own.
 */

/** What mermaid reports a requirement's type as, back to its keyword. */
const TYPE_BY_NAME: Record<string, ReqType> = {
  Requirement: "requirement",
  "Functional Requirement": "functionalRequirement",
  "Interface Requirement": "interfaceRequirement",
  "Performance Requirement": "performanceRequirement",
  "Physical Requirement": "physicalRequirement",
  "Design Constraint": "designConstraint",
};

const RISKS = new Set<string>(["Low", "Medium", "High"]);
const VERIFY = new Set<string>(["Analysis", "Demonstration", "Inspection", "Test"]);

/**
 * A name as the syntax will take it back.
 *
 * Bare when it is a plain identifier, quoted otherwise: the lexer reads
 * `a-b.c` as three tokens and fails, while `"a-b.c"` is one name — and a
 * quoted name works everywhere a bare one does, `style` and `class` included.
 * A double quote cannot be escaped inside one, so it becomes a single quote.
 */
export function reqName(name: string): string {
  return /^[A-Za-z_]\w*$/.test(name) ? name : `"${name.replace(/"/g, "'")}"`;
}

/** A field value, always quoted: text routinely carries colons and commas. */
function value(v: string): string {
  return `"${v.replace(/"/g, "'").replace(/\n/g, " ")}"`;
}

/**
 * The node's own `style` declarations, without the ones a class lent it.
 *
 * Mermaid folds a `classDef`'s declarations into every member's style list,
 * so read as-is a node in class `hot` would come back with `hot`'s colours
 * written out again as its own `style` line — and keep them after leaving the
 * class. Each class's declarations are taken out once, in the order mermaid
 * added them, and what is left is what the node was given directly.
 */
function ownStyles(all: string[], classes: string[], classDefs: ClassDefs): string[] {
  const left = [...all];
  for (const c of classes) {
    for (const decl of classDefs[c] ?? []) {
      const at = left.indexOf(decl);
      if (at >= 0) left.splice(at, 1);
    }
  }
  return left;
}

export function parseRequirement(db: Record<string, (...a: unknown[]) => unknown>): {
  nodes: AnyNode[];
  edges: FlowEdge[];
  classDefs: ClassDefs;
} {
  const classDefs: ClassDefs = {};
  for (const [name, def] of entriesOf(db.getClasses?.())) {
    classDefs[name] = ((def.styles ?? []) as unknown[]).map(String);
  }

  const common = (v: Record<string, unknown>) => {
    // `default` is mermaid's own, on every node; it is not something the
    // document said.
    const classes = ((v.classes ?? []) as unknown[]).map(String).filter((c) => c !== "default");
    const styles = ownStyles(
      ((v.cssStyles ?? []) as unknown[]).map(String),
      classes,
      classDefs,
    );
    return {
      ...(classes.length ? { classes } : {}),
      ...(styles.length ? { styles } : {}),
    };
  };

  const nodes: AnyNode[] = [];
  for (const [name, v] of entriesOf(db.getRequirements?.())) {
    const risk = String(v.risk ?? "");
    const verify = String(v.verifyMethod ?? "");
    const node: RequirementNode = {
      id: name,
      type: "requirement",
      position: { x: 0, y: 0 },
      data: {
        label: name,
        reqType: TYPE_BY_NAME[String(v.type)] ?? "requirement",
        ...(v.requirementId ? { reqId: String(v.requirementId) } : {}),
        ...(v.text ? { text: String(v.text) } : {}),
        ...(RISKS.has(risk) ? { risk: risk as ReqRisk } : {}),
        ...(VERIFY.has(verify) ? { verifyMethod: verify as ReqVerify } : {}),
        ...common(v),
        direction: "TB",
      },
    };
    nodes.push(node);
  }
  for (const [name, v] of entriesOf(db.getElements?.())) {
    const node: RequirementNode = {
      id: name,
      type: "requirement",
      position: { x: 0, y: 0 },
      data: {
        label: name,
        reqType: "element",
        ...(v.type ? { elementType: String(v.type) } : {}),
        ...(v.docRef ? { docRef: String(v.docRef) } : {}),
        ...common(v),
        direction: "TB",
      },
    };
    nodes.push(node);
  }

  const rels = (db.getRelationships?.() ?? []) as Array<Record<string, unknown>>;
  const edges: FlowEdge[] = rels.map((r, i) => {
    const rel = String(r.type) as ReqRelation;
    return {
      id: `e${i}_${r.src}_${r.dst}`,
      source: String(r.src),
      target: String(r.dst),
      data: {
        label: "",
        req: { rel: (REQ_RELATIONS as readonly string[]).includes(rel) ? rel : "traces" },
      },
    };
  });

  return { nodes, edges, classDefs };
}

/* ---------- serialize ---------- */

export function serializeRequirement(
  direction: Direction,
  nodes: AnyNode[],
  edges: FlowEdge[],
  classDefs: ClassDefs = {},
): string {
  const lines: string[] = ["requirementDiagram"];
  if (direction !== "TB" && direction !== "TD") lines.push(`  direction ${direction}`);

  const reqs = nodes.filter((n): n is RequirementNode => n.type === "requirement");
  // Requirements first, then the elements that answer them: the order a
  // reader expects, and the order mermaid's own examples use.
  const ordered = [
    ...reqs.filter((n) => n.data.reqType !== "element"),
    ...reqs.filter((n) => n.data.reqType === "element"),
  ];
  for (const n of ordered) {
    const d = n.data;
    // An empty body is still a body: mermaid requires the braces.
    lines.push(`  ${d.reqType} ${reqName(n.id)} {`);
    if (d.reqType === "element") {
      if (d.elementType) lines.push(`    type: ${value(d.elementType)}`);
      if (d.docRef) lines.push(`    docref: ${value(d.docRef)}`);
    } else {
      if (d.reqId) lines.push(`    id: ${value(d.reqId)}`);
      if (d.text) lines.push(`    text: ${value(d.text)}`);
      if (d.risk) lines.push(`    risk: ${d.risk.toLowerCase()}`);
      if (d.verifyMethod) lines.push(`    verifymethod: ${d.verifyMethod.toLowerCase()}`);
    }
    lines.push("  }");
  }

  if (edges.length > 0) lines.push("");
  for (const e of edges) {
    const rel = e.data?.req?.rel ?? "traces";
    lines.push(`  ${reqName(e.source)} - ${rel} -> ${reqName(e.target)}`);
  }

  const styling: string[] = [];
  for (const [name, styles] of Object.entries(classDefs)) {
    if (styles.length) styling.push(`  classDef ${name} ${styles.join(",")}`);
  }
  for (const n of ordered) {
    if (n.data.classes?.length) {
      styling.push(`  class ${reqName(n.id)} ${n.data.classes.join(",")}`);
    }
  }
  for (const n of ordered) {
    if (n.data.styles?.length) {
      styling.push(`  style ${reqName(n.id)} ${n.data.styles.join(",")}`);
    }
  }
  if (styling.length > 0) lines.push("", ...styling);

  return lines.join("\n") + "\n";
}
