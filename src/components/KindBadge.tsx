import type { DiagramKind } from "../model/types";
import { useT } from "../i18n";

/** Two letters per family: short enough for a tab, distinct from each other. */
const KIND_TAG: Record<DiagramKind, string> = {
  flowchart: "FL",
  state: "ST",
  er: "ER",
  class: "CL",
  sequence: "SQ",
  architecture: "AR",
  c4: "C4",
  requirement: "RQ",
};

/**
 * Which family a document is, without opening it.
 *
 * Two letters and a hue rather than a drawing: at this size a glyph for eight
 * families would be eight smudges, and letters can be read as well as
 * recognised. The badge carries its own label, so the full name is available
 * to anyone who cannot use the hue.
 */
export function KindBadge({ kind }: { kind: DiagramKind }) {
  const t = useT();
  return (
    <span className={`doc-kind k-${kind}`} aria-label={t(`kind.${kind}`)}>
      {KIND_TAG[kind]}
    </span>
  );
}
