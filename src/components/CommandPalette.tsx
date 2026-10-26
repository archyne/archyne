import { useEffect, useMemo, useRef, useState } from "react";
import {
  alignableSelection,
  canGroup,
  groupableSelection,
  sizableSelection,
  useGraphStore,
  type AlignEdge,
} from "../store";
import { useFileStore } from "../files";
import { createDoc, documentList, openFileHere, switchTo } from "../documents";
import { useThemeStore } from "../theme";
import { toast, toastError } from "../toast";
import { useI18n, useT, type MessageKey, type Translate } from "../i18n";
import { formatActiveEditor } from "./editorCommands";
import type { AnyNode, DiagramKind } from "../model/types";

interface Command {
  id: string;
  group: MessageKey;
  label: string;
  hint?: string;
  run: () => void;
}

const KINDS: DiagramKind[] = [
  "flowchart",
  "state",
  "er",
  "class",
  "sequence",
  "architecture",
  "c4",
];

const THEMES = [
  ["dark", "toolbar.themeDark"],
  ["light", "toolbar.themeLight"],
  ["system", "toolbar.themeSystem"],
] as const;

function labelOf(node: AnyNode): string {
  const label = (node.data as { label?: unknown } | undefined)?.label;
  return typeof label === "string" && label.trim() ? label : node.id;
}

/**
 * Everything reachable from the palette.
 *
 * Actions are read from the stores at call time rather than captured, so a
 * command always acts on current state even if the palette was opened before
 * the last edit.
 */
function buildCommands(t: Translate, nodes: AnyNode[], close: () => void): Command[] {
  const wrap = (fn: () => void) => () => {
    close();
    fn();
  };
  const reportingSave = (pick: () => Promise<void>) =>
    wrap(() => {
      void pick()
        .then(() => toast("toast.saved"))
        .catch((err: unknown) => toastError("toast.saveFailed", err));
    });

  const graph = () => useGraphStore.getState();
  const files = () => useFileStore.getState();

  const commands: Command[] = [
    {
      id: "open",
      group: "palette.groupCommands",
      label: t("toolbar.open"),
      hint: "Ctrl+O",
      run: wrap(() => void openFileHere().catch(() => undefined)),
    },
    {
      id: "save",
      group: "palette.groupCommands",
      label: t("toolbar.save"),
      hint: "Ctrl+S",
      run: reportingSave(() => files().save()),
    },
    {
      id: "saveAs",
      group: "palette.groupCommands",
      label: t("toolbar.saveAs"),
      hint: "Ctrl+Shift+S",
      run: reportingSave(() => files().saveAs()),
    },
    {
      id: "undo",
      group: "palette.groupCommands",
      label: t("toolbar.undo"),
      hint: "Ctrl+Z",
      run: wrap(() => void graph().undo()),
    },
    {
      id: "redo",
      group: "palette.groupCommands",
      label: t("toolbar.redo"),
      hint: "Ctrl+Y",
      run: wrap(() => void graph().redo()),
    },
    {
      id: "selectAll",
      group: "palette.groupCommands",
      label: t("shortcuts.selectAll"),
      hint: "Ctrl+A",
      run: wrap(() => graph().selectAll()),
    },
  ];

  commands.push({
    id: "format",
    group: "palette.groupCommands",
    label: t("editor.formatCommand"),
    hint: "Shift+Alt+F",
    run: wrap(() => void formatActiveEditor()),
  });

  // Layout only means anything when there is a graph behind the canvas.
  if (!useGraphStore.getState().unsupported) {
    // One entry per arrangement rather than one for the default: the palette
    // is where a keyboard user reaches everything the toolbar offers, and a
    // choice that only exists behind a mouse is not offered.
    for (const [style, key] of [
      ["auto", "toolbar.layoutAuto"],
      ["layered", "toolbar.layoutLayered"],
      ["bands", "toolbar.layoutBands"],
      ["rectpacking", "toolbar.layoutCompact"],
      ["mrtree", "toolbar.layoutTree"],
      ["force", "toolbar.layoutOrganic"],
    ] as const) {
      commands.push({
        id: `autoLayout-${style}`,
        group: "palette.groupCommands",
        label: `${t("toolbar.autoLayout")}: ${t(key)}`,
        run: wrap(() => void graph().runAutoLayout(style)),
      });
    }
  }

  for (const [choice, key] of THEMES) {
    commands.push({
      id: `theme-${choice}`,
      group: "palette.groupCommands",
      label: `${t("toolbar.theme")}: ${t(key)}`,
      run: wrap(() => useThemeStore.getState().setTheme(choice)),
    });
  }

  for (const kind of KINDS) {
    commands.push({
      id: `new-${kind}`,
      group: "palette.groupNew",
      label: t(`kind.${kind}`),
      run: wrap(() => void createDoc(kind)),
    });
  }

  // Arranging only means anything with a selection to arrange, so these
  // appear when they can act rather than sitting greyed out.
  const arrangeable = alignableSelection(nodes).length;
  if (arrangeable >= 2) {
    for (const [edge, key] of [
      ["left", "insp.alignLeft"],
      ["centerX", "insp.alignCenterX"],
      ["right", "insp.alignRight"],
      ["top", "insp.alignTop"],
      ["middleY", "insp.alignMiddleY"],
      ["bottom", "insp.alignBottom"],
    ] as Array<[AlignEdge, MessageKey]>) {
      commands.push({
        id: `align-${edge}`,
        group: "palette.groupArrange",
        label: `${t("insp.align")}: ${t(key)}`,
        run: wrap(() => graph().alignSelection(edge)),
      });
    }
  }
  if (arrangeable >= 3) {
    for (const [axis, key] of [
      ["x", "insp.distributeX"],
      ["y", "insp.distributeY"],
    ] as Array<["x" | "y", MessageKey]>) {
      commands.push({
        id: `distribute-${axis}`,
        group: "palette.groupArrange",
        label: `${t("insp.distribute")}: ${t(key)}`,
        run: wrap(() => graph().distributeSelection(axis)),
      });
    }
  }
  // The rest of what the selection panel offers, on the same terms, so that
  // nothing it does is reachable only by pointer.
  const { kind } = graph();
  if (kind !== "sequence" && sizableSelection(nodes).length >= 2) {
    for (const [dim, key] of [
      ["width", "insp.matchWidth"],
      ["height", "insp.matchHeight"],
    ] as Array<["width" | "height", MessageKey]>) {
      commands.push({
        id: `match-${dim}`,
        group: "palette.groupArrange",
        label: t(key),
        run: wrap(() => graph().matchSelectionSize(dim)),
      });
    }
  }
  const members = canGroup(kind) ? groupableSelection(nodes).length : 0;
  if (members > 0) {
    commands.push({
      id: "group",
      group: "palette.groupArrange",
      label: t("menu.groupNodes", { count: members }),
      run: wrap(() => graph().groupSelection()),
    });
  }

  // Documents before nodes: with several open, "which diagram" is the
  // question you ask first, and the toolbar menu is the slow way to answer it.
  for (const doc of documentList()) {
    if (doc.active) continue;
    commands.push({
      id: `doc-${doc.id}`,
      group: "palette.groupDocuments",
      label: doc.name,
      run: wrap(() => void switchTo(doc.id)),
    });
  }

  for (const node of nodes) {
    commands.push({
      id: `node-${node.id}`,
      group: "palette.groupNodes",
      label: labelOf(node),
      hint: node.id,
      run: wrap(() => graph().selectOnly(node.id, "node")),
    });
  }

  return commands;
}

/**
 * Ctrl+K. Commands and diagram nodes in one list, because "what can I do"
 * and "where is that node" are the same question once a diagram is large.
 *
 * Deliberately not built on `Modal`: a palette owns its own keyboard model —
 * the input keeps focus while Arrow/Enter drive a separate active row via
 * `aria-activedescendant` — so the shared focus trap would fight it. Escape,
 * focus restore and the dialog roles are handled here instead.
 */
export function CommandPalette({ onClose }: { onClose: () => void }) {
  const t = useT();
  const locale = useI18n((s) => s.locale);
  const nodes = useGraphStore((s) => s.nodes);
  const [query, setQuery] = useState("");
  const [wanted, setWanted] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // `locale` is the dependency, not `t` — `useT` returns a fresh closure each
  // render, which would defeat the memo entirely.
  const commands = useMemo(
    () => buildCommands(t, nodes, onClose),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [locale, nodes, onClose],
  );

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const pool = q
      ? commands.filter(
          (c) => c.label.toLowerCase().includes(q) || c.hint?.toLowerCase().includes(q),
        )
      : commands;
    return pool.slice(0, 40);
  }, [commands, query]);

  // Clamped during render rather than corrected in an effect, which would
  // cascade an extra render on every keystroke that shortens the list.
  const active = Math.min(wanted, Math.max(0, matches.length - 1));

  useEffect(() => {
    const restoreTo = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => restoreTo?.focus?.();
  }, []);

  useEffect(() => {
    listRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  // Bound to the node: a dialog is not an interactive element, so a JSX
  // `onKeyDown` on it is (correctly) flagged, even though trapping keys here
  // is exactly right.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const count = matches.length;
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      } else if (e.key === "ArrowDown" && count > 0) {
        e.preventDefault();
        setWanted((active + 1) % count);
      } else if (e.key === "ArrowUp" && count > 0) {
        e.preventDefault();
        setWanted((active - 1 + count) % count);
      } else if (e.key === "Enter") {
        e.preventDefault();
        matches[active]?.run();
      }
    };
    dialog.addEventListener("keydown", onKeyDown);
    return () => dialog.removeEventListener("keydown", onKeyDown);
  }, [matches, active, onClose]);

  /**
   * Matches bucketed by section, preserving order.
   *
   * The structure matters as much as the grouping: `role="option"` requires a
   * `listbox` or `group` parent, so sections are real `role="group"` elements
   * and options sit directly inside them. Wrapping options in `<li>` inside a
   * `role="listbox"` list breaks that chain — the role override strips the
   * list semantics and orphans both.
   */
  const sections = useMemo(() => {
    const out: Array<{ group: MessageKey; items: Array<{ command: Command; index: number }> }> =
      [];
    matches.forEach((command, index) => {
      const last = out[out.length - 1];
      if (last && last.group === command.group) last.items.push({ command, index });
      else out.push({ group: command.group, items: [{ command, index }] });
    });
    return out;
  }, [matches]);

  return (
    <div
      className="modal-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="modal command-palette"
        role="dialog"
        aria-modal="true"
        aria-label={t("palette.commandTitle")}
      >
        <input
          ref={inputRef}
          className="command-input"
          type="text"
          value={query}
          placeholder={t("palette.commandFilter")}
          aria-label={t("palette.commandFilter")}
          role="combobox"
          aria-expanded="true"
          aria-controls="command-list"
          aria-activedescendant={matches[active] ? `cmd-${matches[active].id}` : undefined}
          onChange={(e) => {
            setQuery(e.target.value);
            setWanted(0);
          }}
        />
        {matches.length === 0 ? (
          <p className="palette-hint command-empty">{t("palette.commandEmpty")}</p>
        ) : (
          <div className="command-list" id="command-list" role="listbox" ref={listRef}>
            {sections.map((section) => (
              <div key={section.group} role="group" aria-label={t(section.group)}>
                <div className="panel-title command-group" aria-hidden="true">
                  {t(section.group)}
                </div>
                {section.items.map(({ command, index }) => (
                  // A real button so it is natively activatable; `tabIndex={-1}`
                  // keeps it out of the tab order, because focus stays in the
                  // input and `aria-activedescendant` conveys the selection.
                  <button
                    key={command.id}
                    type="button"
                    id={`cmd-${command.id}`}
                    role="option"
                    tabIndex={-1}
                    aria-selected={index === active}
                    className={`command-row${index === active ? " active" : ""}`}
                    onMouseMove={() => setWanted(index)}
                    onClick={command.run}
                  >
                    <span>{command.label}</span>
                    {command.hint && <kbd>{command.hint}</kbd>}
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
