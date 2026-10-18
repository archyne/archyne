import { useEffect, useState } from "react";
import { useGraphStore } from "../store";
import { aiMode } from "../ai/provider";
import {
  browserEngineAvailable,
  hostSynced,
  LOCAL_CONNECTION_ID,
  remoteEngineAvailable,
  useAiEngine,
  type AiEngine,
} from "../ai/engine";
import { hostAi } from "../ai/hostBridge";
import { AiRemoteSettings } from "./AiRemoteSettings";
import {
  isLocalUrl,
  presetOf,
  probeServer,
  SERVER_PRESETS,
  type Reachability,
  type ServerPreset,
  type ServerSettings,
} from "../ai/server";
import { remoteAdvice, serverAdvice } from "../ai/serverAdvice";
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
  const engine = useAiEngine((s) => s.engine);
  const setEngine = useAiEngine((s) => s.setEngine);
  const server = useAiEngine((s) => s.server);
  const remote = useAiEngine((s) => s.connections.find((c) => c.id === s.connectionId) ?? null);
  const [request, setRequest] = useState("");
  const t = useT();

  const mode = aiMode();
  const working = (turns[turns.length - 1]?.state ?? null) === "working";
  const onServer = engine === "server";
  const onRemote = engine === "remote";
  const onBrowser = engine === "browser";
  // Sending with no model chosen would only come back as an error, so the
  // composer waits for one instead.
  const ready = onServer ? server.model !== "" : onRemote ? !!remote?.model : true;
  const engines: AiEngine[] = [
    ...(browserEngineAvailable() ? (["browser"] as const) : []),
    "server",
    ...(remoteEngineAvailable() ? (["remote"] as const) : []),
  ];

  const run = () => {
    if (!request.trim() || !ready) return;
    // The document behind the request never changes hands here: the store
    // reads it at send time, so a follow-up edits the diagram on screen now.
    void send(request);
    setRequest("");
  };

  return (
    <div className="ai-panel ai-chat">
      <div className="ai-header">
        {engines.length > 1 && (
          <label className="ai-model">
            {t("ai.engine")}
            <select
              value={engine}
              aria-label={t("ai.engine")}
              disabled={working}
              onChange={(e) => setEngine(e.target.value as AiEngine)}
            >
              {engines.includes("browser") && (
                <option value="browser">{t("ai.engineBrowser")}</option>
              )}
              <option value="server">{t("ai.engineServer")}</option>
              {engines.includes("remote") && (
                <option value="remote">{t("ai.engineRemote")}</option>
              )}
            </select>
          </label>
        )}
        {onBrowser && (
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
        )}
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

      {onServer && <ServerSettingsBlock disabled={working} />}
      {onRemote && <AiRemoteSettings disabled={working} />}

      {onBrowser && mode === "local" && modelStatus.state !== "idle" && (
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
                <p className="ai-error">
                  {/* An error status is shown as the service gave it — its
                      own words say more than a generic line could. */}
                  {!turn.reason || turn.reason === "http"
                    ? t("ai.failed", { error: turn.error ?? "" })
                    : onRemote
                      ? remoteAdvice(t, turn.reason, remote?.baseUrl ?? "", {
                          problem: turn.error ?? undefined,
                        })
                      : serverAdvice(t, turn.reason, server.baseUrl)}
                </p>
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
          placeholder={
            ready
              ? t("ai.placeholder")
              : onRemote
                ? t("ai.remoteNeedsModel")
                : t("ai.serverNeedsModel")
          }
          disabled={working || !ready}
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
            disabled={!request.trim() || !ready}
            onClick={run}
          >
            {t("ai.send")}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Where the local server is and which of its models to use, folded away once
 * a model is chosen: the setting is made once and then the conversation is
 * the point. The connection is checked as soon as the block opens and on
 * every preset, so the model list is never typed by hand and a refusal is
 * explained before a request is ever sent.
 */
/**
 * Check the local server — through the host when there is one, which has no
 * CORS to satisfy, and directly from the page otherwise. Only ever a loopback
 * address: the local engine must not become a way to reach anything else.
 */
async function probeLocal(server: ServerSettings): Promise<Reachability> {
  const ai = hostAi();
  if (!ai || !isLocalUrl(server.baseUrl)) return probeServer(server);
  await hostSynced();
  const result = await ai.probe(LOCAL_CONNECTION_ID);
  return result.state === "invalid" ? { state: "not-local" } : result;
}

function ServerSettingsBlock({ disabled }: { disabled: boolean }) {
  const server = useAiEngine((s) => s.server);
  const setServer = useAiEngine((s) => s.setServer);
  const [address, setAddress] = useState(server.baseUrl);
  // Starts as "checking": the block checks the saved address as it opens.
  const [result, setResult] = useState<Reachability | "checking">("checking");
  const t = useT();

  const check = async (baseUrl: string) => {
    setResult("checking");
    setResult(await probeLocal({ ...useAiEngine.getState().server, baseUrl }));
  };

  useEffect(() => {
    let live = true;
    void probeLocal(useAiEngine.getState().server).then((r) => {
      if (live) setResult(r);
    });
    return () => {
      live = false;
    };
  }, []);

  const commitAddress = (baseUrl: string) => {
    const trimmed = baseUrl.trim();
    setAddress(trimmed);
    if (trimmed === server.baseUrl) return;
    setServer({ baseUrl: trimmed, model: "" });
    void check(trimmed);
  };

  const models = result !== "checking" && result.state === "ok" ? result.models : [];
  // A model chosen earlier stays selectable even if the server does not list
  // it right now (not loaded yet, server still starting).
  const options =
    server.model && !models.includes(server.model) ? [server.model, ...models] : models;
  // A model the server only relays to a cloud service is still offered —
  // choosing it is the person's call — but never without saying so, because
  // "the diagram stays on this computer" would then be untrue.
  const remote = result !== "checking" && result.state === "ok" ? result.remote : [];
  const isCloud = (id: string) => remote.includes(id) || /[-:]cloud$/i.test(id);

  return (
    <details className="ai-server" open={!server.model}>
      <summary>
        {t("ai.serverSummary", { model: server.model || t("ai.serverNoModel") })}
      </summary>
      <p className="ai-server-hint">{t("ai.serverHint")}</p>
      <div className="ai-server-presets">
        {(Object.keys(SERVER_PRESETS) as ServerPreset[]).map((key) => (
          <button
            key={key}
            type="button"
            className="editor-action"
            aria-pressed={presetOf(server.baseUrl) === key}
            disabled={disabled}
            onClick={() => commitAddress(SERVER_PRESETS[key].baseUrl)}
          >
            {SERVER_PRESETS[key].label}
          </button>
        ))}
      </div>
      <label className="ai-server-field">
        {t("ai.serverAddress")}
        <input
          type="url"
          value={address}
          spellCheck={false}
          disabled={disabled}
          onChange={(e) => setAddress(e.target.value)}
          onBlur={(e) => commitAddress(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitAddress(e.currentTarget.value);
          }}
        />
      </label>
      <label className="ai-server-field">
        {t("ai.serverModel")}
        <select
          value={server.model}
          aria-label={t("ai.serverModel")}
          disabled={disabled || options.length === 0}
          onChange={(e) => setServer({ model: e.target.value })}
        >
          <option value="" disabled>
            {t("ai.serverPickModel")}
          </option>
          {options.map((id) => (
            <option key={id} value={id}>
              {isCloud(id) ? t("ai.serverCloudTag", { model: id }) : id}
            </option>
          ))}
        </select>
      </label>
      {server.model && isCloud(server.model) && (
        <p className="ai-server-status ai-server-cloud" role="note">
          {t("ai.serverCloudWarning")}
        </p>
      )}
      <div className="ai-server-check">
        <button
          type="button"
          className="editor-action"
          disabled={disabled || result === "checking"}
          onClick={() => void check(server.baseUrl)}
        >
          {result === "checking" ? t("ai.serverChecking") : t("ai.serverCheck")}
        </button>
        {result !== "checking" && (
          <p
            className={`ai-server-status ai-server-status--${result.state}`}
            role="status"
            data-state={result.state}
          >
            {result.state === "ok"
              ? result.models.length > 0
                ? t("ai.serverOk", { count: result.models.length })
                : t("ai.serverOkEmpty")
              : serverAdvice(
                  t,
                  result.state,
                  server.baseUrl,
                  result.state === "http" ? result.status : undefined,
                )}
          </p>
        )}
      </div>
    </details>
  );
}
