import { StreamLanguage } from "@codemirror/language";

/**
 * Fallback highlighter for the mermaid dialects codemirror-lang-mermaid
 * doesn't know (state, ER, class, architecture-beta, C4, requirement): a lightweight
 * stream tokenizer over keywords, strings, comments and edge operators.
 */
const KEYWORDS = new RegExp(
  "^(" +
    [
      // shared
      "title",
      "accTitle",
      "accDescr",
      "direction",
      "note",
      "end",
      // state
      "stateDiagram-v2",
      "stateDiagram",
      "state",
      // er
      "erDiagram",
      "PK",
      "FK",
      "UK",
      // class
      "classDiagram",
      "class",
      "namespace",
      // architecture
      "architecture-beta",
      "service",
      "group",
      "junction",
      "in",
      // C4
      "C4Context",
      "C4Container",
      "C4Component",
      "C4Dynamic",
      "C4Deployment",
      "Person_Ext",
      "Person",
      "System_Ext",
      "SystemDb",
      "SystemQueue",
      "System_Boundary",
      "System",
      "Container_Ext",
      "ContainerDb",
      "ContainerQueue",
      "Container_Boundary",
      "Container",
      "Component_Ext",
      "ComponentDb",
      "ComponentQueue",
      "Component",
      "Enterprise_Boundary",
      "Boundary",
      "BiRel",
      "Rel_Up",
      "Rel_Down",
      "Rel_Left",
      "Rel_Right",
      "Rel_Back",
      "Rel_U",
      "Rel_D",
      "Rel_L",
      "Rel_R",
      "Rel",
      // requirement (SysML)
      "requirementDiagram",
      "functionalRequirement",
      "interfaceRequirement",
      "performanceRequirement",
      "physicalRequirement",
      "designConstraint",
      "requirement",
      "element",
      "verifymethod",
      "docref",
      "risk",
      "id",
      "text",
      "type",
      "contains",
      "copies",
      "derives",
      "satisfies",
      "verifies",
      "refines",
      "traces",
    ].join("|") +
    ")\\b",
);

export const mermaidFallback = StreamLanguage.define({
  name: "mermaid-fallback",
  token(stream) {
    if (stream.match(/^%%.*/)) return "comment";
    if (stream.match(/^"([^"\\]|\\.)*("|$)/)) return "string";
    if (stream.match(KEYWORDS)) return "keyword";
    // edge operators and cardinalities: -->, <|--, ||--o{, -[label]- rails, [*]
    if (stream.match(/^\[\*\]/)) return "atom";
    if (stream.match(/^([<>|}{oxs*+#]*[-=.]{2,}[<>|}{ox*+#]*|<\||\|>|--|\.\.)/)) {
      return "operator";
    }
    if (stream.match(/^[0-9]+(\.[0-9]+)?/)) return "number";
    if (stream.match(/^[A-Za-z_][\w-]*/)) return "variableName";
    stream.next();
    return null;
  },
});
