import { useState } from "react";
import { useGraphStore } from "../store";
import { aiMode } from "../ai/provider";
import type { AiModel } from "../ai/types";
import { useT } from "../i18n";

/**
 * The Generate panel, as the conversation two people would have about a
 * diagram: what you asked, what became of the drawing, and a composer
 * underneath to ask the next thing.
 *
 * What it deliberately does not do is show you the diagram. The diagram is
 * already on the canvas at full size, and an answer now applies itself there,
 * so a preview here would be a second, smaller copy of the thing being looked
 * at — and an "Insert" button would be a button for making your own request
 * take effect. Each exchange carries its own way back instead, which is the
 * part that actually needed a control.
 */
export function AiPanel() {
  const turns = useGraphStore((s) => s.aiTurns);
  const model = useGraphStore((s) => s.aiModel);
  const modelStatus = useGraphStore((s) => s.aiModelStatus);
  const setModel = useGraphStore((s) => s.setAiModel);
  const send = useGraphStore((s) => s.aiGenerate);
  const cancel = useGraphStore((s) => s.aiCancel);
  const undoTurn = useGraphStore((s) => s.aiUndoTurn);
  const clear = useGraphStore((s) => s.aiClear);
  const [request, setRequest] = useState("");
  const t = useT();

  const mode = aiMode();
  const working = (turns[turns.length - 1]?.state ?? null) === "working";

  const run = () => {
    if (!request.trim()) return;
    // The document behind the request never changes hands here: the store
    // reads it at send time, so a follow-up edits the diagram on screen now.
    void send(request);
    setRequest("");
  };

  if (mode === "off") {
    return (
      <div className="ai-note">
        <h2>{t("ai.notConfiguredTitle")}</h2>
        <p>{t("ai.notConfiguredBody")}</p>
      </div>
    );
  }

  return (
    <div className="ai-panel ai-chat">
      <div className="ai-header">
        <label className="ai-model">
          {t("ai.model")}
          <select
            value={model}
            aria-label={t("ai.model")}
            disabled={working}
            onChange={(e) => setModel(e.target.value as AiModel)}
          >
            <option value="qwen2.5-coder-0.5b">{t("ai.modelSmall")}</option>
            <option value="qwen2.5-coder-1.5b">{t("ai.modelLarge")}</option>
          </select>
        </label>
        <button
          type="button"
          className="editor-action ai-new"
          title={t("ai.newHint")}
          disabled={working || turns.length === 0}
          onClick={clear}
        >
          {t("ai.new")}
        </button>
      </div>

      {mode === "local" && modelStatus.state !== "idle" && (
        <div
          className={`ai-model-status ai-model-status--${modelStatus.state}`}
          role="status"
          data-device={modelStatus.state === "ready" ? modelStatus.device : undefined}
        >
          {modelStatus.state === "downloading" && (
            <span>
              {t("ai.downloading", {
                percent: modelStatus.percent === null ? "…" : String(modelStatus.percent),
              })}
              {modelStatus.file ? ` — ${modelStatus.file}` : ""}
            </span>
          )}
          {modelStatus.state === "warming" && <span>{t("ai.warming")}</span>}
          {modelStatus.state === "ready" && <span>{t("ai.ready")}</span>}
          {modelStatus.state === "error" && (
            <span className="ai-model-error">
              {t("ai.localError", { error: modelStatus.error })}
            </span>
          )}
        </div>
      )}

      <div className="ai-thread">
        {turns.length === 0 && <p className="ai-seed">{t("ai.seed")}</p>}
        {turns.map((turn) => (
          <div className="ai-turn" key={turn.id}>
            <div className="ai-bubble ai-user">{turn.request}</div>
            <div className={`ai-bubble ai-assistant ${turn.state}`}>
              {turn.state === "working" && (
                <p className="ai-status" role="status">
                  <span className="ai-spinner" aria-hidden="true" />
                  {turn.attempts > 1 ? t("ai.retrying") : t("ai.generating")}
                </p>
              )}
              {turn.state === "error" && (
                <p className="ai-error">{t("ai.failed", { error: turn.error ?? "" })}</p>
              )}
              {turn.state === "done" && (
                <p className="ai-applied" role="status">
                  {t("ai.applied")}
                </p>
              )}
              {/* Only while this exchange is still the one that put the
                  current drawing there; once taken back, there is nothing
                  left for the button to undo. */}
              {turn.state === "done" && turn.codeBefore !== null && (
                <div className="ai-actions">
                  <button
                    type="button"
                    title={t("ai.undoTurnHint")}
                    onClick={() => undoTurn(turn.id)}
                  >
                    {t("ai.undoTurn")}
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="ai-composer">
        <textarea
          className="ai-request"
          rows={2}
          value={request}
          placeholder={t("ai.placeholder")}
          disabled={working}
          onChange={(e) => setRequest(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              run();
            }
          }}
        />
        {working ? (
          <button
            type="button"
            className="primary ai-send"
            title={t("ai.cancelHint")}
            onClick={cancel}
          >
            {t("ai.cancel")}
          </button>
        ) : (
          <button
            type="button"
            className="primary ai-send"
            title={t("ai.sendHint")}
            disabled={!request.trim()}
            onClick={run}
          >
            {t("ai.send")}
          </button>
        )}
      </div>
    </div>
  );
}
