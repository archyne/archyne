import { useEffect, useState } from "react";
import { hostSynced, useAiEngine } from "../ai/engine";
import { hostAi, type HostProbe } from "../ai/hostBridge";
import {
  credentialTarget,
  formatHeaders,
  PAGE_SETTABLE_SECRETS,
  parseHeaders,
  wantedSecrets,
  type AuthConfig,
  type Connection,
  type OAuthConfig,
} from "../ai/host/connection";
import { AiOAuthSection } from "./AiOAuthSection";
import { AiVaults } from "./AiVaults";
import type { SecretRef } from "../ai/host/vault";
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
  // Open when a service is shown that still needs a model, decided then and
  // not on every keystroke: picking a model from the list folds it away,
  // typing one (a deployment, a Bedrock model id) does not, or the form would
  // close on the first letter.
  const [shown, setShown] = useState({ id: connectionId, open: !current?.model });
  if (shown.id !== connectionId) setShown({ id: connectionId, open: !current?.model });
  const open = shown.id === connectionId ? shown.open : !current?.model;

  return (
    <>
      <details
        className="ai-server"
        open={open}
        onToggle={(e) => {
          const now = e.currentTarget.open;
          if (now !== open) setShown({ id: connectionId, open: now });
        }}
      >
        <summary>
          {t("ai.remoteSummary", {
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
          <ConnectionForm
            key={current.id}
            connection={current}
            disabled={disabled}
            onPicked={() => setShown({ id: current.id, open: false })}
          />
        ) : (
          <p className="ai-server-hint">{t("ai.remoteNone")}</p>
        )}
      </details>
      <AiVaults disabled={disabled} />
    </>
  );
}

/**
 * What choosing a kind of service fills in: its public address when it has
 * one, and how it authenticates. Only ever over what is still a default, so
 * nothing the person typed is lost by changing their mind.
 */
const PROTOCOL_DEFAULTS: Record<
  "openai" | "anthropic" | "azure" | "bedrock" | "vertex" | "alibaba",
  { baseUrl: string; auth: AuthConfig; hint?: MessageKey }
> = {
  openai: {
    baseUrl: "",
    auth: { type: "header", name: "Authorization", prefix: "Bearer " },
  },
  anthropic: {
    baseUrl: "https://api.anthropic.com/v1",
    auth: { type: "header", name: "x-api-key" },
    hint: "ai.remoteAnthropicHint",
  },
  azure: {
    baseUrl: "",
    auth: { type: "header", name: "api-key" },
    hint: "ai.remoteAzureHint",
  },
  bedrock: {
    baseUrl: bedrockRuntime("us-east-1"),
    auth: { type: "sigv4", region: "us-east-1" },
    hint: "ai.remoteBedrockHint",
  },
  vertex: {
    baseUrl:
      "https://aiplatform.googleapis.com/v1/projects/PROJECT_ID/locations/global/endpoints/openapi",
    auth: {
      type: "oauth",
      flow: "jwt_bearer",
      issuer: "https://accounts.google.com",
      scopes: "https://www.googleapis.com/auth/cloud-platform",
    },
    hint: "ai.remoteVertexHint",
  },
  alibaba: {
    // Singapore, the international region; the hint names the others.
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    auth: { type: "header", name: "Authorization", prefix: "Bearer " },
    hint: "ai.remoteAlibabaHint",
  },
};

function bedrockRuntime(region: string): string {
  return `https://bedrock-runtime.${region}.amazonaws.com`;
}

/** The region in a Bedrock runtime address, so the signature can default to it. */
function regionOf(baseUrl: string): string | null {
  try {
    const host = new URL(baseUrl).hostname;
    return /^bedrock-runtime(?:-fips)?\.([a-z0-9-]+)\.amazonaws\.com$/.exec(host)?.[1] ?? null;
  } catch {
    return null;
  }
}

function ConnectionForm({
  connection,
  disabled,
  onPicked,
}: {
  connection: Connection;
  disabled: boolean;
  /** A model was picked from the list: the settings can fold away. */
  onPicked: () => void;
}) {
  const t = useT();
  const update = useAiEngine((s) => s.updateConnection);
  const vaults = useAiEngine((s) => s.vaults);
  const ai = hostAi();
  const [secretsSet, setSecretsSet] = useState<string[]>([]);
  const [canKeep, setCanKeep] = useState(true);
  const [result, setResult] = useState<HostProbe | "checking" | null>(null);
  const [headersText, setHeadersText] = useState(() => formatHeaders(connection.headers));
  const [fileProblem, setFileProblem] = useState<{ field: string; key: MessageKey } | null>(
    null,
  );
  const patch = (p: Partial<Connection>) => update(connection.id, p);

  // What the host already holds for this connection, and whether it can hold
  // anything at all. Asked again when the connection points somewhere else:
  // the host forgets its secrets then.
  const target = credentialTarget(connection);
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
  }, [ai, connection.id, target]);

  if (!ai) return null;

  const check = async () => {
    setResult("checking");
    await hostSynced();
    setResult(await ai.probe(connection.id));
  };

  const setFromVault = (field: string, ref: SecretRef | undefined) => {
    const rest = Object.fromEntries(
      Object.entries(connection.fromVault ?? {}).filter(([f]) => f !== field),
    );
    const next = ref ? { ...rest, [field]: ref } : rest;
    patch({ fromVault: Object.keys(next).length ? next : undefined });
  };

  const saveSecret = async (field: string, value: string | null) => {
    await hostSynced();
    await ai.setSecret(connection.id, field, value);
    setSecretsSet(await ai.secretFields(connection.id));
  };

  // A certificate or key from a file, which the host opens and reads; what
  // comes back is which fields were saved, or why the file would not do.
  const importFile = async (field: string) => {
    setFileProblem(null);
    await hostSynced();
    const result = await ai.importSecretFile(connection.id, field);
    if ("problem" in result) {
      setFileProblem({ field, key: FILE_PROBLEMS[result.problem] ?? "ai.fileUnreadable" });
    }
    setSecretsSet(await ai.secretFields(connection.id));
  };
  // A PKCS#12 bundle stands for the certificate and its key together.
  const bundled = secretsSet.includes("tlsPfx");

  const setAuth = (type: AuthConfig["type"]) => {
    const auth: AuthConfig =
      type === "header"
        ? { type, name: "Authorization", prefix: "Bearer " }
        : type === "basic"
          ? { type, username: "" }
          : type === "oauth"
            ? { type, flow: "authorization_code", register: true, scopes: "" }
            : type === "sigv4"
              ? { type, region: regionOf(connection.baseUrl) ?? "us-east-1" }
              : { type: "none" };
    patch({ auth });
  };

  const setProtocol = (protocol: keyof typeof PROTOCOL_DEFAULTS) => {
    const was = PROTOCOL_DEFAULTS[connection.protocol as keyof typeof PROTOCOL_DEFAULTS];
    const next = PROTOCOL_DEFAULTS[protocol];
    const p: Partial<Connection> = { protocol, model: "" };
    // A new service starts at a bare "https://"; that is not an address yet.
    const typed = connection.baseUrl !== "https://" && connection.baseUrl !== "";
    if (!typed || connection.baseUrl === was?.baseUrl) p.baseUrl = next.baseUrl || "https://";
    const auth = connection.auth;
    if (auth.type === "none" || (was && JSON.stringify(auth) === JSON.stringify(was.auth))) {
      p.auth = next.auth;
    }
    setResult(null);
    patch(p);
  };
  const defaults = PROTOCOL_DEFAULTS[connection.protocol as keyof typeof PROTOCOL_DEFAULTS];
  // A deployment is a name the person gave, not one the service lists; a
  // Bedrock model may be one only a profile or an ARN names; Alibaba may not
  // list at all. Typed, then, with what the service did list offered alongside.
  const typedModel = ["azure", "bedrock", "vertex", "alibaba"].includes(connection.protocol);
  const suggest = connection.protocol === "bedrock" || connection.protocol === "alibaba";
  const setRegion = (region: string) => {
    const was = connection.auth.type === "sigv4" ? connection.auth : null;
    const p: Partial<Connection> = {
      auth: { type: "sigv4", region, ...(was?.service ? { service: was.service } : {}) },
    };
    // The address follows the region while it is still the default one for it.
    if (
      was &&
      connection.baseUrl === bedrockRuntime(was.region) &&
      /^[a-z0-9-]+$/.test(region)
    ) {
      p.baseUrl = bedrockRuntime(region);
    }
    patch(p);
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
        {t("ai.remoteProtocol")}
        <select
          value={connection.protocol}
          aria-label={t("ai.remoteProtocol")}
          disabled={disabled}
          onChange={(e) => setProtocol(e.target.value as keyof typeof PROTOCOL_DEFAULTS)}
        >
          <option value="openai">{t("ai.remoteProtocolOpenai")}</option>
          <option value="anthropic">Anthropic</option>
          <option value="azure">Azure OpenAI / AI Foundry</option>
          <option value="bedrock">Amazon Bedrock</option>
          <option value="vertex">Google Vertex AI</option>
          <option value="alibaba">Alibaba Cloud Model Studio</option>
        </select>
      </label>
      {defaults?.hint && <p className="ai-server-hint">{t(defaults.hint)}</p>}
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
          <option value="sigv4">{t("ai.remoteAuthSigv4")}</option>
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
      {connection.auth.type === "sigv4" && (
        <div className="ai-remote-row">
          <label className="ai-server-field">
            {t("ai.awsRegion")}
            <input
              type="text"
              value={connection.auth.region}
              spellCheck={false}
              disabled={disabled}
              onChange={(e) => setRegion(e.target.value.trim())}
            />
          </label>
          <label className="ai-server-field">
            {t("ai.awsService")}
            <input
              type="text"
              value={connection.auth.service ?? ""}
              placeholder="bedrock"
              spellCheck={false}
              disabled={disabled}
              onChange={(e) =>
                patch({
                  auth: {
                    type: "sigv4",
                    region: (connection.auth as { region: string }).region,
                    ...(e.target.value.trim() ? { service: e.target.value.trim() } : {}),
                  },
                })
              }
            />
          </label>
        </div>
      )}
      {connection.auth.type === "oauth" && (
        <AiOAuthSection
          connectionId={connection.id}
          target={target}
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
      {connection.clientCertificate && bundled && (
        <div className="ai-server-field">
          <span>{t("ai.tlsPfx")}</span>
          <p className="ai-server-hint" data-saved="true">
            {t("ai.remoteSecretSaved")}
          </p>
          <button
            type="button"
            className="editor-action"
            disabled={disabled || !canKeep}
            onClick={() => void saveSecret("tlsPfx", null)}
          >
            {t("ai.remoteSecretForget")}
          </button>
        </div>
      )}
      {wantedSecrets(connection.auth, connection.clientCertificate)
        .filter((field) => PAGE_SETTABLE_SECRETS.has(field))
        .filter((field) => !(bundled && (field === "tlsCert" || field === "tlsKey")))
        .map((field) => (
          <SecretField
            key={field}
            label={t(
              field === "privateKey" &&
                connection.auth.type === "oauth" &&
                connection.auth.flow === "jwt_bearer"
                ? "ai.oauthAssertionKey"
                : (SECRET_LABELS[field] ?? "ai.remotePassword"),
            )}
            multiline={MULTILINE_SECRETS.has(field)}
            pemLabel={field === "tlsCert" || field === "tlsCa" ? "CERTIFICATE" : "PRIVATE KEY"}
            saved={secretsSet.includes(field)}
            disabled={disabled || !canKeep}
            onSave={(value) => void saveSecret(field, value)}
            onForget={() => void saveSecret(field, null)}
            vaults={vaults}
            fromVault={connection.fromVault?.[field]}
            onFromVault={(ref) => {
              // Read from a vault, a copy kept here would only be stale.
              if (ref && secretsSet.includes(field)) void saveSecret(field, null);
              setFromVault(field, ref);
            }}
            onFile={FILE_FIELDS.has(field) ? () => void importFile(field) : undefined}
            problem={fileProblem?.field === field ? t(fileProblem.key) : undefined}
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

      {typedModel ? (
        <label className="ai-server-field">
          {t(
            connection.protocol === "bedrock"
              ? "ai.remoteBedrockModel"
              : connection.protocol === "azure"
                ? "ai.remoteDeployment"
                : "ai.serverModel",
          )}
          <input
            type="text"
            value={connection.model ?? ""}
            list={suggest ? `ai-models-${connection.id}` : undefined}
            spellCheck={false}
            disabled={disabled}
            onChange={(e) => patch({ model: e.target.value.trim() })}
          />
          {suggest && (
            <datalist id={`ai-models-${connection.id}`}>
              {models.map((id) => (
                <option key={id} value={id} />
              ))}
            </datalist>
          )}
        </label>
      ) : (
        <label className="ai-server-field">
          {t("ai.serverModel")}
          <select
            value={connection.model ?? ""}
            aria-label={t("ai.serverModel")}
            disabled={disabled || options.length === 0}
            onChange={(e) => {
              patch({ model: e.target.value });
              onPicked();
            }}
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
      )}
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
                  problem:
                    result.state === "invalid"
                      ? result.problem
                      : result.state === "vault"
                        ? result.detail
                        : undefined,
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
  pemLabel = "PRIVATE KEY",
  onSave,
  onForget,
  vaults,
  fromVault,
  onFromVault,
  onFile,
  problem,
}: {
  label: string;
  saved: boolean;
  disabled: boolean;
  /** A PEM key spans lines; it is pasted, saved on leaving the field, and emptied. */
  multiline?: boolean;
  /** What the pasted PEM begins with, shown as the empty field's hint. */
  pemLabel?: string;
  onSave: (value: string) => void;
  onForget: () => void;
  /** The vaults the value may be read from instead; none, and the choice is not offered. */
  vaults: Connection[];
  fromVault?: SecretRef;
  onFromVault: (ref: SecretRef | undefined) => void;
  /** Offers to load the value from a file, in the host's own dialog. */
  onFile?: () => void;
  /** Why the last file chosen for this field would not do. */
  problem?: string;
}) {
  const t = useT();
  const [value, setValue] = useState("");
  const commit = () => {
    if (!value) return;
    onSave(value);
    setValue("");
  };
  const vault = fromVault && vaults.find((v) => v.id === fromVault.vault);
  const hashicorp = vault?.vault?.kind === "hashicorp";
  return (
    <div className="ai-server-field">
      {vaults.length > 0 && (
        <label className="ai-server-field">
          {`${label} · ${t("ai.secretSource")}`}
          <select
            value={vault ? vault.id : ""}
            disabled={disabled}
            onChange={(e) =>
              onFromVault(e.target.value ? { vault: e.target.value, name: "" } : undefined)
            }
          >
            <option value="">{t("ai.secretKeptHere")}</option>
            {vaults.map((v) => (
              <option key={v.id} value={v.id}>
                {t("ai.secretVaultOption", { vault: v.label || v.baseUrl })}
              </option>
            ))}
          </select>
        </label>
      )}
      {vault && fromVault ? (
        <>
          <div className="ai-remote-row">
            <label className="ai-server-field">
              {t(hashicorp ? "ai.vaultSecretPath" : "ai.vaultSecretName")}
              <input
                type="text"
                value={fromVault.name}
                spellCheck={false}
                disabled={disabled}
                onChange={(e) => onFromVault({ ...fromVault, name: e.target.value.trim() })}
              />
            </label>
            <label className="ai-server-field">
              {t(hashicorp ? "ai.vaultSecretField" : "ai.vaultSecretKey")}
              <input
                type="text"
                value={fromVault.key ?? ""}
                spellCheck={false}
                placeholder={hashicorp ? "value" : ""}
                disabled={disabled}
                onChange={(e) =>
                  onFromVault({ ...fromVault, key: e.target.value.trim() || undefined })
                }
              />
            </label>
          </div>
          <p className="ai-server-hint">{t("ai.vaultSecretHint")}</p>
        </>
      ) : (
        <label className="ai-server-field">
          {label}
          {multiline ? (
            <textarea
              rows={3}
              value={value}
              autoComplete="off"
              spellCheck={false}
              placeholder={saved ? t("ai.remoteSecretSaved") : `-----BEGIN ${pemLabel}-----`}
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
      )}
      {!vault && (onFile || saved) && (
        <div className="ai-secret-actions">
          {onFile && (
            <button
              type="button"
              className="editor-action"
              disabled={disabled}
              onClick={onFile}
            >
              {t("ai.secretFromFile")}
            </button>
          )}
          {saved && (
            <button
              type="button"
              className="editor-action"
              disabled={disabled}
              onClick={onForget}
            >
              {t("ai.remoteSecretForget")}
            </button>
          )}
        </div>
      )}
      {problem && (
        <p className="ai-server-status" role="status">
          {problem}
        </p>
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
  accessKeyId: "ai.awsAccessKeyId",
  secretAccessKey: "ai.awsSecretAccessKey",
  sessionToken: "ai.awsSessionToken",
};

/** Why a file chosen for a secret would not do. */
const FILE_PROBLEMS: Partial<Record<string, MessageKey>> = {
  "too-large": "ai.fileTooLarge",
  empty: "ai.fileEmpty",
  "not-certificate": "ai.fileNotCertificate",
  "not-key": "ai.fileNotKey",
};

/** The fields a file can be loaded into (src/ai/host/secretFile.ts). */
const FILE_FIELDS = new Set(["tlsCert", "tlsKey", "tlsCa", "privateKey"]);

/** PEM blocks span lines; everything else is one. */
const MULTILINE_SECRETS = new Set(["privateKey", "tlsCert", "tlsKey", "tlsCa"]);
