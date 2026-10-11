import { useState } from "react";
import { useGraphStore } from "../store";
import { CodeEditor } from "./CodeEditor";
import { formatActiveEditor } from "./editorCommands";
import { MermaidPreview } from "./MermaidPreview";
import { GraphOutline } from "./GraphOutline";
import { AiPanel } from "./AiPanel";
import { Modal } from "./Modal";
import { MAX_EDITOR_FONT_SIZE, MIN_EDITOR_FONT_SIZE, usePrefs } from "../prefs";
import { useT } from "../i18n";

/**
 * The editor's own strip: what an IDE puts under the tab bar.
 *
 * Formatting and type size are both here rather than in the application
 * toolbar because they act on the code and on nothing else — and because
 * the keyboard bindings for them (Shift+Alt+F, Ctrl+=) only fire while the
 * editor has focus, so this is where you look for them.
 */
function EditorBar() {
  const fontSize = usePrefs((s) => s.editorFontSize);
  const nudge = usePrefs((s) => s.nudgeEditorFontSize);
  const reset = usePrefs((s) => s.resetEditorFontSize);
  const t = useT();

  return (
    <div className="editor-bar">
      <button
        type="button"
        className="editor-action"
        title={t("editor.formatHint")}
        onClick={() => formatActiveEditor()}
      >
        {t("editor.format")}
      </button>
      <div className="editor-zoom" role="group" aria-label={t("editor.fontSize")}>
        <button
          type="button"
          className="editor-action"
          title={t("editor.fontSmaller")}
          aria-label={t("editor.fontSmaller")}
          disabled={fontSize <= MIN_EDITOR_FONT_SIZE}
          onClick={() => nudge(-1)}
        >
          <span aria-hidden="true">A−</span>
        </button>
        {/* Clicking the number puts it back, the way a zoom readout does. */}
        <button
          type="button"
          className="editor-action editor-zoom-value"
          title={t("editor.fontReset")}
          aria-label={t("editor.fontReset")}
          onClick={() => reset()}
        >
          {fontSize}px
        </button>
        <button
          type="button"
          className="editor-action"
          title={t("editor.fontLarger")}
          aria-label={t("editor.fontLarger")}
          disabled={fontSize >= MAX_EDITOR_FONT_SIZE}
          onClick={() => nudge(1)}
        >
          <span aria-hidden="true">A+</span>
        </button>
      </div>
    </div>
  );
}

export function CodePanel() {
  const code = useGraphStore((s) => s.code);
  const parseError = useGraphStore((s) => s.parseError);
  const warning = useGraphStore((s) => s.warning);
  const aiOpen = useGraphStore((s) => s.aiOpen);
  const setCodeFromEditor = useGraphStore((s) => s.setCodeFromEditor);
  const [tab, setTab] = useState<"code" | "preview" | "outline" | "generate">("code");
  const [expanded, setExpanded] = useState(false);
  const t = useT();

  // The toolbar opens the panel with "Generate with AI": whatever clause was
  // on screen, the AI tab is the point of the gesture. Adjusted during render
  // (the docs' pattern for "hold this state, but jump at a prop change") so
  // the old tab never glides in for a frame first.
  const [seenAiOpen, setSeenAiOpen] = useState(aiOpen);
  if (aiOpen !== seenAiOpen) {
    setSeenAiOpen(aiOpen);
    if (aiOpen) setTab("generate");
  }

  return (
    <section className="code-panel" aria-label={t("panel.mermaidSource")}>
      <div className="tabs" role="tablist" aria-label={t("panel.sourceView")}>
        <button
          className={tab === "code" ? "tab active" : "tab"}
          role="tab"
          id="tab-code"
          aria-selected={tab === "code"}
          aria-controls="panel-code"
          onClick={() => setTab("code")}
        >
          {t("panel.tabCode")}
        </button>
        <button
          className={tab === "preview" ? "tab active" : "tab"}
          role="tab"
          id="tab-preview"
          aria-selected={tab === "preview"}
          aria-controls="panel-preview"
          onClick={() => setTab("preview")}
        >
          {t("panel.tabPreview")}
        </button>
        <button
          className={tab === "outline" ? "tab active" : "tab"}
          role="tab"
          id="tab-outline"
          aria-selected={tab === "outline"}
          aria-controls="panel-outline"
          onClick={() => setTab("outline")}
        >
          {t("panel.tabOutline")}
        </button>
        <button
          className={tab === "generate" ? "tab active" : "tab"}
          role="tab"
          id="tab-generate"
          aria-selected={tab === "generate"}
          aria-controls="panel-generate"
          onClick={() => setTab("generate")}
        >
          {t("ai.tab")}
        </button>
      </div>
      {tab === "code" ? (
        <div id="panel-code" role="tabpanel" aria-labelledby="tab-code" className="tabpanel">
          <EditorBar />
          <CodeEditor value={code} onChange={setCodeFromEditor} />
          {/* Not a live region: these are only rendered on the code tab, so
              announcing from here would go silent whenever the user is on
              Preview or working on the canvas. `StatusAnnouncer` in App.tsx
              is always mounted and owns the announcement. */}
          {parseError && <div className="parse-error">{parseError}</div>}
          {!parseError && warning && <div className="parse-warning">{warning}</div>}
        </div>
      ) : tab === "outline" ? (
        <div
          id="panel-outline"
          role="tabpanel"
          aria-labelledby="tab-outline"
          className="tabpanel outline-panel"
        >
          <GraphOutline />
        </div>
      ) : tab === "generate" ? (
        <div
          id="panel-generate"
          role="tabpanel"
          aria-labelledby="tab-generate"
          className="tabpanel"
        >
          <AiPanel />
        </div>
      ) : (
        <div
          id="panel-preview"
          role="tabpanel"
          aria-labelledby="tab-preview"
          className="tabpanel"
        >
          {/* The panel is as narrow as the editor beside it, and Mermaid draws
              at whatever size the diagram comes out — so a wide graph lands
              here too small to read. This is the way out of the column. */}
          <div className="editor-bar preview-bar">
            <button
              type="button"
              className="editor-action"
              title={t("panel.expandHint")}
              onClick={() => setExpanded(true)}
            >
              <span aria-hidden="true">⤢</span> {t("panel.expand")}
            </button>
          </div>
          <MermaidPreview code={code} className="preview" />
        </div>
      )}
      {expanded && (
        <Modal
          title={t("panel.previewTitle")}
          className="preview-modal"
          onClose={() => setExpanded(false)}
        >
          {/* Drawn again rather than moved: the SVG in the panel is sized for
              the panel, and this copy is sized to fill the dialog. */}
          <MermaidPreview code={code} className="preview-full" />
          <div className="modal-actions">
            <button onClick={() => setExpanded(false)}>{t("common.close")}</button>
          </div>
        </Modal>
      )}
    </section>
  );
}
