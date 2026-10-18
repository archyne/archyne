import * as oauth from "oauth4webapi";
import { isIssuerUrl, parseTokens, type OAuthConfig, type StoredTokens } from "./connection";

/**
 * OAuth for a person signing in, run by the host (AUTH.local.md, phase 2).
 *
 * Built on oauth4webapi rather than by hand: it checks what hand-written
 * flows forget — the state, the PKCE verifier, the issuer of an authorization
 * response, the nonce of an ID token. What this file adds is the shape of an
 * editor's sign-in: where the authorization server is found, how the browser
 * comes back, where the tokens go, and when they are refreshed.
 *
 * Deliberately absent: the implicit and password grants. OAuth 2.1 removes
 * both and RFC 9700 says not to use them.
 */

/** A loopback listener for the browser's return (RFC 8252 §7.3). */
export interface Loopback {
  /** `http://127.0.0.1:<port>/callback`. */
  redirectUri: string;
  /** Resolves with the URL the browser came back to. */
  waitForCallback(signal: AbortSignal): Promise<URL>;
  close(): void;
}

export interface OAuthEnv {
  fetch: typeof fetch;
  /** Opens the system browser — never an embedded one: the app must not see the password. */
  openExternal(url: string): Promise<void>;
  loopback(): Promise<Loopback>;
  now(): number;
  /** Waits between device-code polls; injectable so tests need not sleep. */
  sleep(ms: number): Promise<void>;
}

/** The secrets an OAuth connection reads and writes, by field. */
export interface OAuthSecrets {
  get(field: "clientSecret" | "tokens" | "client"): Promise<string | undefined>;
  set(field: "tokens" | "client", value: string): Promise<void>;
  delete(field: "tokens" | "client"): Promise<void>;
}

/** What the page is told while a device-code sign-in waits for the person. */
export interface DeviceCodePrompt {
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
}

/** How long a sign-in may wait for the person before it gives up. */
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;
/** Refresh a little before expiry, so a request never leaves with a token about to lapse. */
const EXPIRY_MARGIN_MS = 60_000;

function requestOptions(env: OAuthEnv, url: string, signal?: AbortSignal) {
  return {
    [oauth.customFetch]: env.fetch,
    // Plain http only for a loopback server (a local identity provider, or a
    // test); oauth4webapi refuses it everywhere else, as it should.
    [oauth.allowInsecureRequests]: new URL(url).protocol === "http:",
    signal,
  };
}

/**
 * Find the authorization server: the configured issuer, or — when none is
 * given — the one the service itself names in its Protected Resource
 * Metadata (RFC 9728), which is how MCP servers and modern gateways say it.
 */
export async function discover(
  config: OAuthConfig,
  baseUrl: string,
  env: OAuthEnv,
): Promise<oauth.AuthorizationServer> {
  let issuer = config.issuer;
  if (!issuer) {
    const resource = new URL(baseUrl);
    const response = await oauth.resourceDiscoveryRequest(
      resource,
      requestOptions(env, baseUrl),
    );
    const rs = await oauth.processResourceDiscoveryResponse(resource, response);
    issuer = rs.authorization_servers?.[0];
    if (!issuer) throw new Error("The service names no authorization server.");
  }
  if (!isIssuerUrl(issuer)) throw new Error("The authorization server address is not https.");
  const url = new URL(issuer);
  // OpenID Connect discovery first, then plain OAuth metadata (RFC 8414).
  for (const algorithm of ["oidc", "oauth2"] as const) {
    try {
      const response = await oauth.discoveryRequest(url, {
        ...requestOptions(env, issuer),
        algorithm,
      });
      return await oauth.processDiscoveryResponse(url, response);
    } catch (err) {
      if (algorithm === "oauth2") throw err;
    }
  }
  throw new Error("unreachable");
}

/** The client this connection signs in as: configured, or registered and remembered. */
async function clientFor(
  config: OAuthConfig,
  as: oauth.AuthorizationServer,
  secrets: OAuthSecrets,
  env: OAuthEnv,
): Promise<{ client: oauth.Client; auth: oauth.ClientAuth }> {
  const secret = await secrets.get("clientSecret");
  if (config.clientId) {
    return {
      client: { client_id: config.clientId },
      auth: secret ? oauth.ClientSecretBasic(secret) : oauth.None(),
    };
  }
  const stored = await secrets.get("client");
  if (stored) {
    const registered = JSON.parse(stored) as { client_id: string; client_secret?: string };
    return {
      client: { client_id: registered.client_id },
      auth: registered.client_secret
        ? oauth.ClientSecretBasic(registered.client_secret)
        : oauth.None(),
    };
  }
  if (!config.register) throw new Error("No client id, and registration is off.");
  if (!as.registration_endpoint) {
    throw new Error(
      "This authorization server does not allow registration; a client id is needed.",
    );
  }
  // RFC 7591, as a native app: a loopback redirect without a port, which
  // RFC 8252 §7.3 obliges the server to accept on any port.
  const response = await oauth.dynamicClientRegistrationRequest(
    as,
    {
      client_name: "Archyne",
      application_type: "native",
      redirect_uris: ["http://127.0.0.1/callback"],
      grant_types: [
        "authorization_code",
        "urn:ietf:params:oauth:grant-type:device_code",
        "refresh_token",
      ],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    requestOptions(env, as.issuer),
  );
  const registered = await oauth.processDynamicClientRegistrationResponse(response);
  await secrets.set(
    "client",
    JSON.stringify({
      client_id: registered.client_id,
      client_secret: registered.client_secret,
    }),
  );
  return {
    client: { client_id: registered.client_id },
    auth: registered.client_secret
      ? oauth.ClientSecretBasic(String(registered.client_secret))
      : oauth.None(),
  };
}

/** The extra parameters a provider needs to issue a token for the right API. */
function audienceParams(config: OAuthConfig): Record<string, string> {
  const p: Record<string, string> = {};
  if (config.resource) p.resource = config.resource;
  if (config.audience) p.audience = config.audience;
  return p;
}

function store(tokens: oauth.TokenEndpointResponse, env: OAuthEnv, previous?: StoredTokens) {
  const stored: StoredTokens = {
    access_token: tokens.access_token,
    // A server that does not rotate keeps the old refresh token valid.
    refresh_token: tokens.refresh_token ?? previous?.refresh_token,
    expires_at:
      typeof tokens.expires_in === "number" ? env.now() + tokens.expires_in * 1000 : undefined,
    scope: tokens.scope,
  };
  return JSON.stringify(stored);
}

/**
 * Sign in. Opens the system browser for an authorization code (with PKCE and
 * a loopback redirect), or shows a device code and polls for the person to
 * finish. The tokens are stored by the host and never returned.
 */
export async function signIn(
  config: OAuthConfig,
  baseUrl: string,
  secrets: OAuthSecrets,
  env: OAuthEnv,
  onDeviceCode: (prompt: DeviceCodePrompt) => void,
  signal: AbortSignal = AbortSignal.timeout(SIGN_IN_TIMEOUT_MS),
): Promise<void> {
  const as = await discover(config, baseUrl, env);
  const { client, auth } = await clientFor(config, as, secrets, env);
  const scope = config.scopes?.trim() || undefined;
  const options = requestOptions(env, as.issuer, signal);

  if (config.flow === "device_code") {
    const params: Record<string, string> = { ...audienceParams(config) };
    if (scope) params.scope = scope;
    const response = await oauth.deviceAuthorizationRequest(as, client, auth, params, options);
    const device = await oauth.processDeviceAuthorizationResponse(as, client, response);
    onDeviceCode({
      userCode: device.user_code,
      verificationUri: device.verification_uri,
      verificationUriComplete: device.verification_uri_complete,
      expiresIn: device.expires_in,
    });
    await env.openExternal(device.verification_uri_complete ?? device.verification_uri);
    let interval = (device.interval ?? 5) * 1000;
    const deadline = env.now() + device.expires_in * 1000;
    while (env.now() < deadline) {
      if (signal.aborted) throw new Error("The sign-in was cancelled.");
      await env.sleep(interval);
      try {
        const poll = await oauth.deviceCodeGrantRequest(
          as,
          client,
          auth,
          device.device_code,
          options,
        );
        const tokens = await oauth.processDeviceCodeResponse(as, client, poll);
        await secrets.set("tokens", store(tokens, env));
        return;
      } catch (err) {
        if (err instanceof oauth.ResponseBodyError) {
          if (err.error === "authorization_pending") continue;
          if (err.error === "slow_down") {
            interval += 5000; // RFC 8628 §3.5
            continue;
          }
        }
        throw err;
      }
    }
    throw new Error("The device code expired before the sign-in finished.");
  }

  if (!as.authorization_endpoint) throw new Error("The server has no authorization endpoint.");
  const loopback = await env.loopback();
  try {
    const verifier = oauth.generateRandomCodeVerifier();
    const state = oauth.generateRandomState();
    const wantsIdToken = scope?.split(/\s+/).includes("openid") ?? false;
    const nonce = wantsIdToken ? oauth.generateRandomNonce() : undefined;
    const url = new URL(as.authorization_endpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", client.client_id);
    url.searchParams.set("redirect_uri", loopback.redirectUri);
    url.searchParams.set("code_challenge", await oauth.calculatePKCECodeChallenge(verifier));
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", state);
    if (scope) url.searchParams.set("scope", scope);
    if (nonce) url.searchParams.set("nonce", nonce);
    for (const [k, v] of Object.entries(audienceParams(config))) url.searchParams.set(k, v);

    await env.openExternal(url.href);
    const callback = await loopback.waitForCallback(signal);
    // Checks the state, the issuer (RFC 9207) and any error the server sent.
    const params = oauth.validateAuthResponse(as, client, callback, state);
    const response = await oauth.authorizationCodeGrantRequest(
      as,
      client,
      auth,
      params,
      loopback.redirectUri,
      verifier,
      { ...options, additionalParameters: audienceParams(config) },
    );
    const tokens = await oauth.processAuthorizationCodeResponse(as, client, response, {
      expectedNonce: nonce,
      requireIdToken: wantsIdToken,
    });
    await secrets.set("tokens", store(tokens, env));
  } finally {
    loopback.close();
  }
}

/**
 * A token good for the next request: the stored one, or a refreshed one when
 * it is about to lapse (or `force`, after a 401). Null when nobody is signed
 * in, or the refresh was refused — the panel then says "signed out".
 */
export async function accessToken(
  config: OAuthConfig,
  baseUrl: string,
  secrets: OAuthSecrets,
  env: OAuthEnv,
  force = false,
): Promise<string | null> {
  const tokens = parseTokens(await secrets.get("tokens"));
  if (!tokens) return null;
  const fresh = !tokens.expires_at || tokens.expires_at - EXPIRY_MARGIN_MS > env.now();
  if (fresh && !force) return tokens.access_token;
  if (!tokens.refresh_token) return force ? null : tokens.access_token;
  try {
    const as = await discover(config, baseUrl, env);
    const { client, auth } = await clientFor(config, as, secrets, env);
    const response = await oauth.refreshTokenGrantRequest(
      as,
      client,
      auth,
      tokens.refresh_token,
      { ...requestOptions(env, as.issuer), additionalParameters: audienceParams(config) },
    );
    const next = await oauth.processRefreshTokenResponse(as, client, response);
    // Rotation (OAuth 2.1): the new refresh token replaces the old in one write.
    await secrets.set("tokens", store(next, env, tokens));
    return next.access_token;
  } catch {
    await secrets.delete("tokens");
    return null;
  }
}

/** Sign out: revoke at the server where it allows (RFC 7009), and forget locally regardless. */
export async function signOut(
  config: OAuthConfig,
  baseUrl: string,
  secrets: OAuthSecrets,
  env: OAuthEnv,
): Promise<void> {
  const tokens = parseTokens(await secrets.get("tokens"));
  await secrets.delete("tokens");
  if (!tokens) return;
  try {
    const as = await discover(config, baseUrl, env);
    if (!as.revocation_endpoint) return;
    const { client, auth } = await clientFor(config, as, secrets, env);
    const token = tokens.refresh_token ?? tokens.access_token;
    await oauth.revocationRequest(as, client, auth, token, requestOptions(env, as.issuer));
  } catch {
    // Revocation is a courtesy; the local tokens are already gone.
  }
}

/** What the page may know about a sign-in: whether, and until when. */
export async function authStatus(
  secrets: OAuthSecrets,
): Promise<{ signedIn: boolean; expiresAt?: number }> {
  const tokens = parseTokens(await secrets.get("tokens"));
  return tokens ? { signedIn: true, expiresAt: tokens.expires_at } : { signedIn: false };
}
