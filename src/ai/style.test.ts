import { describe, expect, it } from "vitest";
import { parseDiagram } from "../model/diagram";
import { applyHouseStyle, iconForLabel, withIcons } from "./style";

describe("the icon a label earns", () => {
  it("recognises what a step is about", () => {
    expect(iconForLabel("Database")).toBe("carbon:data-base");
    expect(iconForLabel("Send email")).toBe("carbon:email");
    expect(iconForLabel("Postgres")).toBe("logos:postgresql");
  });

  it("takes the specific name over the generic one", () => {
    // Both patterns match; the one that says more has to win, or every
    // database in the drawing becomes a plain server.
    expect(iconForLabel("Redis cache server")).toBe("logos:redis");
  });

  it("offers nothing for a label that is not about anything in particular", () => {
    expect(iconForLabel("Do the thing")).toBeNull();
    expect(iconForLabel("Step two")).toBeNull();
  });
});

describe("giving plain nodes an icon", () => {
  it("rewrites a plain rectangle whose label asks for one", () => {
    const out = withIcons('flowchart TD\n  db["Database"]\n');
    expect(out).toContain('db@{ icon: "carbon:data-base", label: "Database", pos: "t" }');
  });

  it("leaves a shape that means something alone", () => {
    // A diamond is a decision and a stadium is a terminator: mermaid takes
    // one form per node, so an icon would cost the shape, which says more.
    const code = 'flowchart TD\n  check{"Database valid?"}\n  done(["Email sent"])\n';
    expect(withIcons(code)).toBe(code);
  });

  it("does not touch a node that already says how it is drawn", () => {
    const code = 'flowchart TD\n  db@{ icon: "logos:aws-rds", label: "Database", pos: "t" }\n';
    expect(withIcons(code)).toBe(code);
  });

  it("leaves an unquoted label alone rather than guessing where it ends", () => {
    const code = "flowchart TD\n  db[Database]\n";
    expect(withIcons(code)).toBe(code);
  });

  it("is not fooled by an edge line that mentions a node", () => {
    const code = "flowchart TD\n  a --> db\n  db --> b\n";
    expect(withIcons(code)).toBe(code);
  });

  it("keeps the header and the indentation it was given", () => {
    const out = withIcons('flowchart TD\n  user["Customer"]\n');
    expect(out.startsWith("flowchart TD\n")).toBe(true);
    expect(out.split("\n")[1].startsWith("  ")).toBe(true);
  });

  it("leaves a diagram with nothing to say exactly as it was", () => {
    const code = 'flowchart TD\n  a["Step one"] --> b["Step two"]\n';
    expect(applyHouseStyle(code)).toBe(code);
  });

  it("reaches a definition written inside a chain, as a real model writes them", () => {
    // The shape a stub never produces and a model always does. The arrow
    // keeps the bare id; the node is declared underneath.
    const out = withIcons('flowchart TD\n  b --> d["Wait"] --> e["Database"]\n');
    // Only the node that earns an icon is lifted out: the chain keeps its
    // bare id, and the label moves to a declaration underneath.
    expect(out).toContain('b --> d["Wait"] --> e');
    expect(out).not.toContain('e["Database"]');
    expect(out).toContain('e@{ icon: "carbon:data-base", label: "Database", pos: "t" }');
    // "Wait" earns nothing, so it keeps its brackets and stays where it is.
    expect(out).toContain('d["Wait"]');
  });

  it("declares a node once, however many times the chain mentions it", () => {
    const out = withIcons('flowchart TD\n  a --> db["Database"]\n  db["Database"] --> c\n');
    expect(out.match(/db@\{/g)).toHaveLength(1);
  });
});

describe("what the pass hands back is still mermaid", () => {
  // The point of these: the syntax above is asserted as strings everywhere
  // else, and a string assertion cannot tell you the parser agrees. The
  // orchestrator throws a styled answer away if it does not parse, so a pass
  // that quietly never applied would look exactly like success.
  it("parses after a definition standing on its own line is rewritten", async () => {
    const out = withIcons('flowchart TD\n  db["Database"]\n  db --> done(["Done"])\n');
    expect(out).toContain("db@{");
    await expect(parseDiagram(out)).resolves.toBeTruthy();
  });

  it("parses after a definition is lifted out of a chain", async () => {
    const out = withIcons('flowchart TD\n  a["Start"] --> e["Database"] --> z["End"]\n');
    expect(out).toContain("e@{");
    await expect(parseDiagram(out)).resolves.toBeTruthy();
  });
});
