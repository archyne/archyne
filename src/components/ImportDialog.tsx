import { useState } from "react";
import { Modal } from "./Modal";
import { MermaidPreview } from "./MermaidPreview";
import { PanZoom } from "./PanZoom";
import { CanvasPreview } from "./CanvasPreview";
import { useT } from "../i18n";
import { placeOpenedPages, usePendingImport } from "../documents";
import { sniffKind } from "../model/sniff";
import { openAsMermaid, type OpenedFile } from "../importFile";
import type { DiagramKind } from "../model/types";

/** The product name behind each format code. None of these is translated. */
const SOURCE: Record<string, string> = {
  drawio: "draw.io",
  dot: "Graphviz",
  sql: "SQL",
  excalidraw: "Excalidraw",
  plantuml: "PlantUML",
  vsdx: "Visio",
  lucid: "Lucidchart",
};

/**
 * What a conversion produced, shown before it lands.
 *
 * Every import is lossy — a foreign format says things Mermaid cannot — and
 * the moment to discover that is *before* the result has replaced what you
 * were looking at. So the conversion runs, and its outcome is put up with the
 * counts, the warnings, and the diagram itself drawn by Mermaid's own
 * renderer. Cancelling costs nothing: nothing has been placed yet.
 */
export function ImportDialog({ opened }: { opened: OpenedFile }) {
  const t = useT();
  // The canvas cannot lay out a sequence diagram — its rows come from the
  // message order rather than from geometry — so that one opens on the
  // rendering that can show it.
  const [view, setView] = useState<"canvas" | "mermaid" | "source">(
    sniffKind(opened.file.content) === "sequence" ? "mermaid" : "canvas",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => usePendingImport.setState({ pending: null });

  const { file, imported } = opened;
  const source = (imported && SOURCE[imported.format]) ?? imported?.format ?? "";
  // What it actually is, read back off the generated document rather than
  // taken on trust from the converter that wrote it.
  const kind = sniffKind(file.content);
  const choices = imported?.choices ?? [];
  const pages = imported?.pages ?? [];
  // A file can have several pages; the index that was imported lives on the
  // summary so this selection and the conversion always agree.
  const page = imported?.page ?? 0;
  const pickable = imported?.page !== undefined && pages.length > 1;
  // The pages that will be imported. Until one is ticked by hand, it is the
  // page on show — so picking a page to look at and pressing Import does what
  // it always did — and after that, whatever was ticked.
  const [ticked, setTicked] = useState<Set<number> | null>(null);
  const chosen = ticked ?? new Set([page]);
  const tick = (next: Set<number>) => setTicked(new Set(next));
  // The family the reader picked by hand, which every page is read as; left
  // unset, each page is read as whatever it looks like.
  const [as, setAs] = useState<DiagramKind | undefined>(undefined);

  /** Convert again, the reader's guess overruled or another page picked. */
  const reconvert = (over: { as?: DiagramKind; page?: number }) => {
    setBusy(true);
    setError(null);
    // Each choice keeps the other: picking a page does not undo the family
    // the reader chose, and choosing a family does not go back to page one.
    openAsMermaid(
      opened.source,
      over.as ?? (choices.includes(kind as DiagramKind) ? (kind as DiagramKind) : undefined),
      over.page ?? (imported?.page !== undefined ? page : undefined),
    )
      .then((next) => usePendingImport.setState({ pending: next }))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  const confirm = async () => {
    setBusy(true);
    setError(null);
    const wanted = [...chosen].sort((a, b) => a - b);
    try {
      // Every page is converted before any is placed: one that fails stops
      // the import with nothing half-done, as a single page always has.
      const list = [];
      for (const i of wanted) {
        list.push(i === page ? opened : await openAsMermaid(opened.source, as, i));
      }
      await placeOpenedPages(
        list,
        wanted.map((i) => pages[i]),
      );
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <Modal className="import-modal" title={t("import.title", { source })} onClose={close}>
      <div className="modal-body">
        <div className="export-opts">
          {/* The target family, as a control rather than a statement: the
              detection is a guess, and the reader is the one who knows. */}
          {/* Always shown, so what it decided is never a guess the reader
              has to make from the picture. Disabled when the source can only
              be read one way — the answer is still worth stating. */}
          <label>
            {t("import.readAs")}
            <select
              value={kind ?? choices[0]}
              disabled={busy || choices.length < 2}
              onChange={(e) => {
                setAs(e.target.value as DiagramKind);
                reconvert({ as: e.target.value as DiagramKind });
              }}
            >
              {(choices.includes(kind as DiagramKind) || !kind
                ? choices
                : [...choices, kind]
              ).map((c) => (
                <option key={c} value={c}>
                  {t(`kind.${c}`)}
                </option>
              ))}
            </select>
          </label>

          {/* A file of several pages is one page in the way a book is one
              chapter: the first is a guess at what was meant — a draw.io
              file is often an overview and then its details. The reader
              picks, the conversion runs again, and nothing lands until the
              confirm below. Offered by every format that can convert a page
              other than the first. */}
          {pickable && (
            <label>
              {t("import.readAsPage")}
              <select
                value={String(page)}
                disabled={busy}
                onChange={(e) => reconvert({ page: Number(e.target.value) })}
              >
                {pages.map((title, i) => (
                  <option key={i} value={String(i)}>
                    {title}
                  </option>
                ))}
              </select>
            </label>
          )}
          {/* Which pages land, each as a document of its own: an overview
              and its details are worth having side by side, and importing
              them one at a time meant going through this dialog per page. */}
          {pickable && (
            <fieldset className="import-pages" disabled={busy}>
              <legend>{t("import.pagesToImport")}</legend>
              <label>
                <input
                  type="checkbox"
                  checked={chosen.size === pages.length}
                  // Some but not all: with the list scrolled, the dash says
                  // there is a choice made further down.
                  ref={(box) => {
                    if (box) box.indeterminate = chosen.size > 0 && chosen.size < pages.length;
                  }}
                  onChange={(e) =>
                    tick(e.target.checked ? new Set(pages.map((_, i) => i)) : new Set())
                  }
                />
                {t("import.allPages")}
              </label>
              {/* A file can hold dozens of pages: the list scrolls in a box of
                  its own so the rest of the dialog stays where it is. */}
              <div className="import-page-list">
                {pages.map((title, i) => (
                  <label key={i}>
                    <input
                      type="checkbox"
                      checked={chosen.has(i)}
                      onChange={(e) => {
                        const next = new Set(chosen);
                        if (e.target.checked) next.add(i);
                        else next.delete(i);
                        tick(next);
                      }}
                    />
                    {title}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <p className="import-summary">
            {t("import.counts", {
              nodes: String(imported?.nodes ?? 0),
              edges: String(imported?.edges ?? 0),
            })}
          </p>

          {/* Everything the conversion could not do, stated here rather than
              in a toast that has gone by the time the diagram is on screen. */}
          {imported && imported.pages.length > 1 && imported.page === undefined && (
            <p className="field-hint">
              {t("import.onePage", {
                page: imported.pages[0],
                count: String(imported.pages.length),
              })}
            </p>
          )}
          {imported?.looksLike && (
            <p className="field-hint">
              {t("import.looksLike", { family: imported.looksLike })}
            </p>
          )}
          {!!imported?.dropped && (
            <p className="field-hint">
              {t("import.dropped", { count: String(imported.dropped) })}
            </p>
          )}
          {error && <p className="preview-error">{error}</p>}
          <p className="field-hint">{t("import.unbound", { name: file.name })}</p>

          {/* Three ways to look at it: the canvas it will be edited on, the
              picture Mermaid draws, and the text that was generated. */}
          <div className="import-views" role="group" aria-label={t("import.view")}>
            {(["canvas", "mermaid", "source"] as const).map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                onClick={() => setView(v)}
              >
                {t(`import.view.${v}`)}
              </button>
            ))}
          </div>
        </div>

        {/* Both views scroll, so both must be reachable by keyboard — a pane
            you can only read by dragging it is not readable at all (WCAG
            2.1.1), and axe fails it as `scrollable-region-focusable`.
            The `group` role with a name is what makes that legitimate, and
            the lint rule is configured to accept it. */}
        <div className="export-preview import-preview">
          {view === "source" && (
            <pre
              className="import-source"
              tabIndex={0}
              role="group"
              aria-label={t("import.sourceAlt")}
            >
              {file.content}
            </pre>
          )}
          {view === "mermaid" && (
            <div className="import-render">
              {/* Mermaid lays diagrams out itself and ignores the positions
                  the document carries, so for an imported drawing this pane
                  is "how it renders elsewhere" rather than a second opinion
                  on the import. Worth saying, because on a large drawing the
                  two look nothing alike and the difference is not a fault in
                  the conversion. */}
              {file.content.includes("%% graph:positions") && (
                <p className="import-render-note">{t("import.mermaidLayout")}</p>
              )}
              <PanZoom label={t("import.previewAlt")}>
                <MermaidPreview code={file.content} />
              </PanZoom>
            </div>
          )}
          {/* React Flow brings its own zoom and pan, and its own tabstops. */}
          {view === "canvas" && (
            <div className="import-canvas">
              <CanvasPreview code={file.content} />
            </div>
          )}
        </div>
      </div>
      <div className="modal-actions">
        <button onClick={close}>{t("import.cancel")}</button>
        <button
          className="primary"
          onClick={() => void confirm()}
          disabled={busy || chosen.size === 0}
        >
          {chosen.size > 1
            ? t("import.confirmPages", { count: String(chosen.size) })
            : t("import.confirm")}
        </button>
      </div>
    </Modal>
  );
}

/** Rendered once, wherever the other dialogs live. */
export function PendingImport() {
  const pending = usePendingImport((s) => s.pending);
  return pending ? <ImportDialog opened={pending} /> : null;
}
