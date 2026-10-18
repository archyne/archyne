import { useEffect, useState } from "react";
import { hostSynced } from "../ai/engine";
import { hostAi, type AuthStatus } from "../ai/hostBridge";
import type { OAuthConfig } from "../ai/host/connection";
import { useI18n, useT } from "../i18n";

/**
 * OAuth for a remote service: how to sign in, where, as which client — and
 * the sign-in itself. The host runs the whole flow and keeps the tokens; this
 * section only starts it, shows a device code when there is one, and learns
 * whether someone is signed in and until when.
 */
export function AiOAuthSection({
  connectionId,
  config,
  disabled,
  onChange,
}: {
  connectionId: string;
  config: OAuthConfig;
  disabled: boolean;
  onChange: (config: OAuthConfig) => void;
}) {
  const t = useT();
  const locale = useI18n((s) => s.locale);
  const ai = hostAi();
  const [status, setStatus] = useState<AuthStatus>({ signedIn: false });
  const [busy, setBusy] = useState(false);
  const [device, setDevice] = useState<{ userCode: string; uri: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<OAuthConfig>) => onChange({ ...config, ...patch });

  useEffect(() => {
    if (!ai) return;
    let live = true;
    void hostSynced()
      .then(() => ai.authStatus(connectionId))
      .then((s) => live && setStatus(s));
    // Sign-in progress for this connection, whichever call started it.
    const stop = ai.onEvent((event) => {
      if (event.type !== "ai:auth" || event.connectionId !== connectionId) return;
      if (event.state === "device-code") {
        setDevice({
          userCode: event.userCode,
          uri: event.verificationUriComplete ?? event.verificationUri,
        });
        return;
      }
      setDevice(null);
      setBusy(false);
      setError(event.state === "error" ? (event.detail ?? "") : null);
      void ai.authStatus(connectionId).then((s) => live && setStatus(s));
    });
    return () => {
      live = false;
      stop();
    };
  }, [ai, connectionId]);

  if (!ai) return null;

  const signIn = async () => {
    setBusy(true);
    setError(null);
    await hostSynced();
    await ai.signIn(connectionId);
  };
  const signOut = async () => {
    await hostSynced();
    await ai.signOut(connectionId);
    setStatus(await ai.authStatus(connectionId));
  };
  const until = status.expiresAt
    ? new Date(status.expiresAt).toLocaleTimeString(locale, {
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;

  return (
    <>
      <label className="ai-server-field">
        {t("ai.oauthFlow")}
        <select
          value={config.flow}
          aria-label={t("ai.oauthFlow")}
          disabled={disabled || busy}
          onChange={(e) => set({ flow: e.target.value as OAuthConfig["flow"] })}
        >
          <option value="authorization_code">{t("ai.oauthFlowBrowser")}</option>
          <option value="device_code">{t("ai.oauthFlowDevice")}</option>
          <option value="client_credentials">{t("ai.oauthFlowMachine")}</option>
        </select>
      </label>
      <label className="ai-server-field">
        {t("ai.oauthIssuer")}
        <input
          type="url"
          value={config.issuer ?? ""}
          placeholder={t("ai.oauthIssuerHint")}
          spellCheck={false}
          disabled={disabled || busy}
          onChange={(e) => set({ issuer: e.target.value.trim() || undefined })}
        />
      </label>
      <label className="ai-server-field">
        {t("ai.oauthClientId")}
        <input
          type="text"
          value={config.clientId ?? ""}
          spellCheck={false}
          disabled={disabled || busy}
          onChange={(e) => set({ clientId: e.target.value.trim() || undefined })}
        />
      </label>
      {config.flow !== "client_credentials" && (
        <label className="ai-oauth-check">
          <input
            type="checkbox"
            checked={!!config.register}
            disabled={disabled || busy}
            onChange={(e) => set({ register: e.target.checked })}
          />
          {t("ai.oauthRegister")}
        </label>
      )}
      <label className="ai-server-field">
        {t("ai.oauthClientAuth")}
        <select
          value={config.clientAuth ?? ""}
          aria-label={t("ai.oauthClientAuth")}
          disabled={disabled || busy}
          onChange={(e) =>
            set({ clientAuth: (e.target.value || undefined) as OAuthConfig["clientAuth"] })
          }
        >
          <option value="">{t("ai.oauthClientAuthAuto")}</option>
          <option value="client_secret_basic">{t("ai.oauthClientAuthBasic")}</option>
          <option value="client_secret_post">{t("ai.oauthClientAuthPost")}</option>
          <option value="private_key_jwt">{t("ai.oauthClientAuthKey")}</option>
          <option value="tls_client_auth">{t("ai.oauthClientAuthTls")}</option>
        </select>
      </label>
      <label className="ai-oauth-check">
        <input
          type="checkbox"
          checked={!!config.dpop}
          disabled={disabled || busy}
          onChange={(e) => set({ dpop: e.target.checked })}
        />
        {t("ai.oauthDpop")}
      </label>
      {config.clientAuth === "private_key_jwt" && (
        <label className="ai-server-field">
          {t("ai.oauthKeyId")}
          <input
            type="text"
            value={config.keyId ?? ""}
            spellCheck={false}
            disabled={disabled || busy}
            onChange={(e) => set({ keyId: e.target.value.trim() || undefined })}
          />
        </label>
      )}
      <label className="ai-server-field">
        {t("ai.oauthScopes")}
        <input
          type="text"
          value={config.scopes ?? ""}
          spellCheck={false}
          disabled={disabled || busy}
          onChange={(e) => set({ scopes: e.target.value })}
        />
      </label>
      <div className="ai-remote-row">
        <label className="ai-server-field">
          {t("ai.oauthResource")}
          <input
            type="text"
            value={config.resource ?? ""}
            spellCheck={false}
            disabled={disabled || busy}
            onChange={(e) => set({ resource: e.target.value.trim() || undefined })}
          />
        </label>
        <label className="ai-server-field">
          {t("ai.oauthAudience")}
          <input
            type="text"
            value={config.audience ?? ""}
            spellCheck={false}
            disabled={disabled || busy}
            onChange={(e) => set({ audience: e.target.value.trim() || undefined })}
          />
        </label>
      </div>

      <div className="ai-server-check">
        {busy ? (
          <button
            type="button"
            className="editor-action"
            onClick={() => {
              ai.cancelSignIn(connectionId);
              setBusy(false);
              setDevice(null);
            }}
          >
            {t("ai.oauthCancel")}
          </button>
        ) : status.signedIn ? (
          <button
            type="button"
            className="editor-action"
            disabled={disabled}
            onClick={() => void signOut()}
          >
            {t("ai.oauthSignOut")}
          </button>
        ) : (
          <button
            type="button"
            className="editor-action"
            disabled={disabled}
            onClick={() => void signIn()}
          >
            {t("ai.oauthSignIn")}
          </button>
        )}
        <p
          className={`ai-server-status${status.signedIn ? " ai-server-status--ok" : ""}`}
          role="status"
          data-auth={busy ? "busy" : status.signedIn ? "signed-in" : "signed-out"}
        >
          {busy
            ? device
              ? null
              : t("ai.oauthWaiting")
            : status.signedIn
              ? until
                ? t("ai.oauthSignedInUntil", { time: until })
                : t("ai.oauthSignedIn")
              : error !== null
                ? t("ai.oauthFailed", { error })
                : t("ai.oauthSignedOut")}
        </p>
        {busy && device && (
          <div className="ai-oauth-device" role="status">
            <p>
              {t("ai.oauthDeviceCode")}{" "}
              <a href={device.uri} target="_blank" rel="noreferrer">
                {device.uri}
              </a>
            </p>
            <p className="ai-oauth-code">{device.userCode}</p>
          </div>
        )}
      </div>
    </>
  );
}
