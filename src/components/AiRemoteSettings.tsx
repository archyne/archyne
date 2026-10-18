import { useEffect, useState } from "react";
import { hostSynced, useAiEngine } from "../ai/engine";
import { hostAi, type HostProbe } from "../ai/hostBridge";
import {
  formatHeaders,
  PAGE_SETTABLE_SECRETS,
  parseHeaders,
  wantedSecrets,
  type AuthConfig,
  type Connection,
  type OAuthConfig,
} from "../ai/host/connection";
import { AiOAuthSection } from "./AiOAuthSection";
import { remoteAdvice } from "../ai/serverAdvice";
import { useT, type MessageKey } from "../i18n";

/**
 * The remote services Generate can use from the desktop app or VS Code, and
 * how each one authenticates.
 *
 * Secrets are write-only from here. A key or a password typed into this form
 * goes to the host once (`setSecret`) and the field is emptied; afterwards the
 * form only learns *that* a secret is set (`secretFields`), never what it is —
 * the page is where pasted diagrams and model output are rendered, and so the
 * last place a credential should be readable (AUTH.local.md).
 */
export function AiRemoteSettings({ disabled }: { disabled: boolean }) {
  const t = useT();
  const connections = useAiEngine((s) => s.connections);
  const connectionId = useAiEngine((s) => s.connectionId);
  const addConnection = useAiEngine((s) => s.addConnection);
  const removeConnection = useAiEngine((s) => s.removeConnection);
  const selectConnection = useAiEngine((s) => s.selectConnection);
  const current = connections.find((c) => c.id === connectionId) ?? null;

  return (
    <details className="ai-server" open={!current?.model}>
      <summary>
        {t("ai.serverSummary", {
          model: current
            ? `${current.label} · ${current.model || t("ai.serverNoModel")}`
            : t("ai.serverNoModel"),
        })}
      </summary>
      <div className="ai-server-presets">
        {connections.length > 0 && (
          <label className="ai-server-field ai-remote-pick">
            {t("ai.remoteService")}
            <select
              value={connectionId ?? ""}
              aria-label={t("ai.remoteService")}
              disabled={disabled}
              onChange={(e) => selectConnection(e.target.value)}
            >
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label || c.baseUrl}
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          type="button"
          className="editor-action"
          disabled={disabled}
          onClick={() => addConnection(t("ai.remoteNewName"))}
        >
          {t("ai.remoteAdd")}
        </button>
        {current && (
          <button
            type="button"
            className="editor-action"
            disabled={disabled}
            onClick={() => removeConnection(current.id)}
          >
            {t("ai.remoteRemove")}
          </button>
        )}
      </div>
      {current ? (
        <ConnectionForm key={current.id} connection={current} disabled={disabled} />
      ) : (
        <p className="ai-server-hint">{t("ai.remoteNone")}</p>
      )}
    </details>
  );
}

function ConnectionForm({
  connection,
  disabled,
}: {
  connection: Connection;
  disabled: boolean;
}) {
  const t = useT();
  const update = useAiEngine((s) => s.updateConnection);
  const ai = hostAi();
  const [secretsSet, setSecretsSet] = useState<string[]>([]);
  const [canKeep, setCanKeep] = useState(true);
  const [result, setResult] = useState<HostProbe | "checking" | null>(null);
  const [headersText, setHeadersText] = useState(() => formatHeaders(connection.headers));
  const patch = (p: Partial<Connection>) => update(connection.id, p);

  // What the host already holds for this connection, and whether it can hold
  // anything at all. Asked once per connection shown.
  useEffect(() => {
    if (!ai) return;
    let live = true;
    void hostSynced()
      .then(() => Promise.all([ai.secretFields(connection.id), ai.canKeepSecrets()]))
      .then(([fields, keep]) => {
        if (!live) return;
        setSecretsSet(fields);
        setCanKeep(keep);
      });
    return () => {
      live = false;
    };
  }, [ai, connection.id]);

  if (!ai) return null;

  const check = async () => {
    setResult("checking");
    await hostSynced();
    setResult(await ai.probe(connection.id));
  };

  const saveSecret = async (field: string, value: string | null) => {
    await hostSynced();
    await ai.setSecret(connection.id, field, value);
    setSecretsSet(await ai.secretFields(connection.id));
  };

  const setAuth = (type: AuthConfig["type"]) => {
    const auth: AuthConfig =
      type === "header"
        ? { type, name: "Authorization", prefix: "Bearer " }
        : type === "basic"
          ? { type, username: "" }
          : type === "oauth"
            ? { type, flow: "authorization_code", register: true, scopes: "" }
            : { type: "none" };
    patch({ auth });
  };

  const models = result && result !== "checking" && result.state === "ok" ? result.models : [];
  const options =
    connection.model && !models.includes(connection.model)
      ? [connection.model, ...models]
      : models;

  return (
    <>
      <label className="ai-server-field">
        {t("ai.remoteName")}
        <input
          type="text"
          value={connection.label}
          disabled={disabled}
          onChange={(e) => patch({ label: e.target.value })}
        />
      </label>
      <label className="ai-server-field">
        {t("ai.serverAddress")}
        <input
          type="url"
          value={connection.baseUrl}
          spellCheck={false}
          disabled={disabled}
          onChange={(e) => patch({ baseUrl: e.target.value.trim() })}
        />
      </label>
      <label className="ai-server-field">
        {t("ai.remoteAuth")}
        <select
          value={connection.auth.type}
          aria-label={t("ai.remoteAuth")}
          disabled={disabled}
          onChange={(e) => setAuth(e.target.value as AuthConfig["type"])}
        >
          <option value="none">{t("ai.remoteAuthNone")}</option>
          <option value="header">{t("ai.remoteAuthHeader")}</option>
          <option value="basic">{t("ai.remoteAuthBasic")}</option>
          <option value="oauth">{t("ai.remoteAuthOAuth")}</option>
        </select>
      </label>

      {connection.auth.type === "header" && (
        <div className="ai-remote-row">
          <label className="ai-server-field">
            {t("ai.remoteHeaderName")}
            <input
              type="text"
              value={connection.auth.name}
              spellCheck={false}
              disabled={disabled}
              onChange={(e) =>
                patch({
                  auth: {
                    ...(connection.auth as { type: "header"; name: string }),
                    name: e.target.value.trim(),
                  },
                })
              }
            />
          </label>
          <label className="ai-server-field">
            {t("ai.remoteHeaderPrefix")}
            <input
              type="text"
              value={connection.auth.prefix ?? ""}
              spellCheck={false}
              disabled={disabled}
              onChange={(e) =>
                patch({
                  auth: {
                    ...(connection.auth as { type: "header"; name: string }),
                    prefix: e.target.value,
                  },
                })
              }
            />
          </label>
        </div>
      )}
      {connection.auth.type === "basic" && (
        <label className="ai-server-field">
          {t("ai.remoteUsername")}
          <input
            type="text"
            value={connection.auth.username}
            autoComplete="off"
            disabled={disabled}
            onChange={(e) => patch({ auth: { type: "basic", username: e.target.value } })}
          />
        </label>
      )}
      {connection.auth.type === "oauth" && (
        <AiOAuthSection
          connectionId={connection.id}
          config={connection.auth}
          disabled={disabled}
          onChange={(auth: OAuthConfig) => patch({ auth })}
        />
      )}
      <label className="ai-oauth-check">
        <input
          type="checkbox"
          checked={!!connection.clientCertificate}
          disabled={disabled}
          onChange={(e) => patch({ clientCertificate: e.target.checked })}
        />
        {t("ai.tlsClientCertificate")}
      </label>
      {connection.clientCertificate && <p className="ai-server-hint">{t("ai.tlsHint")}</p>}
      {wantedSecrets(connection.auth, connection.clientCertificate)
        .filter((field) => PAGE_SETTABLE_SECRETS.has(field))
        .map((field) => (
          <SecretField
            key={field}
            label={t(SECRET_LABELS[field] ?? "ai.remotePassword")}
            multiline={MULTILINE_SECRETS.has(field)}
            saved={secretsSet.includes(field)}
            disabled={disabled || !canKeep}
            onSave={(value) => void saveSecret(field, value)}
            onForget={() => void saveSecret(field, null)}
          />
        ))}
      {!canKeep && <p className="ai-server-status">{t("ai.remoteNoSecureStorage")}</p>}

      <label className="ai-server-field">
        {t("ai.remoteHeaders")}
        <textarea
          rows={2}
          value={headersText}
          spellCheck={false}
          disabled={disabled}
          onChange={(e) => setHeadersText(e.target.value)}
          onBlur={() => patch({ headers: parseHeaders(headersText) })}
        />
      </label>
      <p className="ai-server-hint">{t("ai.remoteHint")}</p>

      <label className="ai-server-field">
        {t("ai.serverModel")}
        <select
          value={connection.model ?? ""}
          aria-label={t("ai.serverModel")}
          disabled={disabled || options.length === 0}
          onChange={(e) => patch({ model: e.target.value })}
        >
          <option value="" disabled>
            {t("ai.serverPickModel")}
          </option>
          {options.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
      </label>
      <div className="ai-server-check">
        <button
          type="button"
          className="editor-action"
          disabled={disabled || result === "checking"}
          onClick={() => void check()}
        >
          {result === "checking" ? t("ai.serverChecking") : t("ai.serverCheck")}
        </button>
        {result && result !== "checking" && (
          <p
            className={`ai-server-status ai-server-status--${result.state}`}
            role="status"
            data-state={result.state}
          >
            {result.state === "ok"
              ? result.models.length > 0
                ? t("ai.serverOk", { count: result.models.length })
                : t("ai.serverOkEmpty")
              : remoteAdvice(t, result.state, connection.baseUrl, {
                  status: result.state === "http" ? result.status : undefined,
                  problem: result.state === "invalid" ? result.problem : undefined,
                })}
          </p>
        )}
      </div>
    </>
  );
}

/**
 * A write-only secret: typed, saved to the host, and emptied. Once saved it
 * reads "saved" — the value itself is never shown, because it was never
 * given back.
 */
function SecretField({
  label,
  saved,
  disabled,
  multiline = false,
  onSave,
  onForget,
}: {
  label: string;
  saved: boolean;
  disabled: boolean;
  /** A PEM key spans lines; it is pasted, saved on leaving the field, and emptied. */
  multiline?: boolean;
  onSave: (value: string) => void;
  onForget: () => void;
}) {
  const t = useT();
  const [value, setValue] = useState("");
  const commit = () => {
    if (!value) return;
    onSave(value);
    setValue("");
  };
  return (
    <div className="ai-server-field">
      <label className="ai-server-field">
        {label}
        {multiline ? (
          <textarea
            rows={3}
            value={value}
            autoComplete="off"
            spellCheck={false}
            placeholder={saved ? t("ai.remoteSecretSaved") : "-----BEGIN PRIVATE KEY-----"}
            disabled={disabled}
            data-saved={saved || undefined}
            onChange={(e) => setValue(e.target.value)}
            onBlur={commit}
          />
        ) : (
          <input
            type="password"
            value={value}
            autoComplete="off"
            placeholder={saved ? t("ai.remoteSecretSaved") : ""}
            disabled={disabled}
            data-saved={saved || undefined}
            onChange={(e) => setValue(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
            }}
          />
        )}
      </label>
      {saved && (
        <button type="button" className="editor-action" disabled={disabled} onClick={onForget}>
          {t("ai.remoteSecretForget")}
        </button>
      )}
    </div>
  );
}

/** The label each secret field is asked for under. */
const SECRET_LABELS: Record<string, MessageKey> = {
  key: "ai.remoteKey",
  password: "ai.remotePassword",
  clientSecret: "ai.oauthClientSecret",
  privateKey: "ai.oauthPrivateKey",
  tlsCert: "ai.tlsCert",
  tlsKey: "ai.tlsKey",
  tlsPassphrase: "ai.tlsPassphrase",
  tlsCa: "ai.tlsCa",
};

/** PEM blocks span lines; everything else is one. */
const MULTILINE_SECRETS = new Set(["privateKey", "tlsCert", "tlsKey", "tlsCa"]);
