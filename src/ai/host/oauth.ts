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
  get(
    field: "clientSecret" | "privateKey" | "tokens" | "client" | "dpopKey",
  ): Promise<string | undefined>;
  set(field: "tokens" | "client" | "dpopKey", value: string): Promise<void>;
  delete(field: "tokens" | "client" | "dpopKey"): Promise<void>;
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

function requestOptions(
  env: OAuthEnv,
  url: string,
  signal?: AbortSignal,
  dpop?: oauth.DPoPHandle,
) {
  return {
    [oauth.customFetch]: env.fetch,
    // Plain http only for a loopback server (a local identity provider, or a
    // test); oauth4webapi refuses it everywhere else, as it should.
    [oauth.allowInsecureRequests]: new URL(url).protocol === "http:",
    signal,
    DPoP: dpop,
  };
}

/** One DPoP handle per key, so the server's nonces are remembered between requests. */
const dpopHandles = new Map<string, oauth.DPoPHandle>();

/**
 * The connection's DPoP key (RFC 9449), made on first use and kept with its
 * tokens: a DPoP-bound token works only with the key it was bound to, so the
 * two have to survive a restart together. Undefined when DPoP is off.
 */
async function dpopHandle(
  config: OAuthConfig,
  secrets: OAuthSecrets,
): Promise<oauth.DPoPHandle | undefined> {
  if (!config.dpop) return undefined;
  let stored = await secrets.get("dpopKey");
  if (!stored) {
    const pair = await oauth.generateKeyPair("ES256", { extractable: true });
    stored = JSON.stringify({
      privateKey: await crypto.subtle.exportKey("jwk", pair.privateKey),
      publicKey: await crypto.subtle.exportKey("jwk", pair.publicKey),
    });
    await secrets.set("dpopKey", stored);
  }
  const cached = dpopHandles.get(stored);
  if (cached) return cached;
  const jwks = JSON.parse(stored) as { privateKey: JsonWebKey; publicKey: JsonWebKey };
  const alg = { name: "ECDSA", namedCurve: "P-256" };
  const handle = oauth.DPoP(
    {},
    {
      privateKey: await crypto.subtle.importKey("jwk", jwks.privateKey, alg, false, ["sign"]),
      // Extractable: the public half travels in every proof's header.
      publicKey: await crypto.subtle.importKey("jwk", jwks.publicKey, alg, true, ["verify"]),
    },
  );
  dpopHandles.set(stored, handle);
  return handle;
}

/**
 * Once more when the server asks for a DPoP nonce (RFC 9449 §8): the handle
 * has remembered the nonce from the refusal, and the second proof carries it.
 */
async function withNonce<T>(attempt: () => Promise<T>): Promise<T> {
  try {
    return await attempt();
  } catch (err) {
    if (oauth.isDPoPNonceError(err)) return attempt();
    throw err;
  }
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
      auth: await clientAuthentication(config, secret, secrets),
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

/**
 * How the client proves itself at the token endpoint, as configured — or,
 * when nothing is configured, the secret in a Basic header if there is one
 * and nothing otherwise (a public client, with PKCE carrying the proof).
 */
async function clientAuthentication(
  config: OAuthConfig,
  secret: string | undefined,
  secrets: OAuthSecrets,
): Promise<oauth.ClientAuth> {
  const method = config.clientAuth ?? (secret ? "client_secret_basic" : undefined);
  switch (method) {
    case "client_secret_basic":
    case "client_secret_post":
      if (!secret)
        throw new Error("This client authenticates with a secret, and none is saved.");
      return method === "client_secret_basic"
        ? oauth.ClientSecretBasic(secret)
        : oauth.ClientSecretPost(secret);
    case "private_key_jwt": {
      const pem = await secrets.get("privateKey");
      if (!pem)
        throw new Error("This client authenticates with a private key, and none is saved.");
      return oauth.PrivateKeyJwt({
        key: await importPrivateKey(pem),
        kid: config.keyId || undefined,
      });
    }
    case "tls_client_auth":
      // The proof is the client certificate on the connection itself (RFC
      // 8705); the request carries only the client id.
      return oauth.TlsClientAuth();
    default:
      return oauth.None();
  }
}

/**
 * A PEM private key as a signing CryptoKey, with the algorithm its type
 * implies: RS256 for RSA, ES256/384/512 by curve, EdDSA for Ed25519 — which is
 * what the server will expect for the key it was given the public half of.
 */
export async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const { createPrivateKey } = await import("node:crypto");
  const key = createPrivateKey(pem);
  const der = key.export({ type: "pkcs8", format: "der" });
  const curves: Record<string, [string, string]> = {
    prime256v1: ["P-256", "SHA-256"],
    secp384r1: ["P-384", "SHA-384"],
    secp521r1: ["P-521", "SHA-512"],
  };
  let algorithm: RsaHashedImportParams | EcKeyImportParams | { name: "Ed25519" };
  switch (key.asymmetricKeyType) {
    case "rsa":
      algorithm = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
      break;
    case "ec": {
      const curve = curves[String(key.asymmetricKeyDetails?.namedCurve)];
      if (!curve) throw new Error("This elliptic curve is not one OAuth signs with.");
      algorithm = { name: "ECDSA", namedCurve: curve[0] };
      break;
    }
    case "ed25519":
      algorithm = { name: "Ed25519" };
      break;
    default:
      throw new Error("The private key must be RSA, EC (P-256/384/521) or Ed25519.");
  }
  return crypto.subtle.importKey("pkcs8", der, algorithm, false, ["sign"]);
}

/** A token for the client itself (RFC 6749 §4.4), stored like any other. */
async function clientCredentialsToken(
  as: oauth.AuthorizationServer,
  client: oauth.Client,
  auth: oauth.ClientAuth,
  config: OAuthConfig,
  secrets: OAuthSecrets,
  env: OAuthEnv,
  signal?: AbortSignal,
): Promise<string> {
  const params: Record<string, string> = { ...audienceParams(config) };
  const scope = config.scopes?.trim();
  if (scope) params.scope = scope;
  const dpop = await dpopHandle(config, secrets);
  const tokens = await withNonce(async () => {
    const response = await oauth.clientCredentialsGrantRequest(
      as,
      client,
      auth,
      params,
      requestOptions(env, as.issuer, signal, dpop),
    );
    return oauth.processClientCredentialsResponse(as, client, response);
  });
  await secrets.set("tokens", store(tokens, env));
  return tokens.access_token;
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
    token_type: tokens.token_type,
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
  const dpop = await dpopHandle(config, secrets);
  const options = requestOptions(env, as.issuer, signal, dpop);

  if (config.flow === "client_credentials") {
    // No person: "signing in" is getting the first token, which also proves
    // the client id and its credential are right.
    await clientCredentialsToken(as, client, auth, config, secrets, env, signal);
    return;
  }

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
        // A DPoP nonce request: the handle now has it, and the next poll sends it.
        if (oauth.isDPoPNonceError(err)) continue;
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
    // Binds the code itself to the DPoP key (RFC 9449 §10).
    if (dpop) url.searchParams.set("dpop_jkt", await dpop.calculateThumbprint());

    await env.openExternal(url.href);
    const callback = await loopback.waitForCallback(signal);
    // Checks the state, the issuer (RFC 9207) and any error the server sent.
    const params = oauth.validateAuthResponse(as, client, callback, state);
    const tokens = await withNonce(async () => {
      const response = await oauth.authorizationCodeGrantRequest(
        as,
        client,
        auth,
        params,
        loopback.redirectUri,
        verifier,
        { ...options, additionalParameters: audienceParams(config) },
      );
      return oauth.processAuthorizationCodeResponse(as, client, response, {
        expectedNonce: nonce,
        requireIdToken: wantsIdToken,
      });
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
  const fresh =
    !!tokens && (!tokens.expires_at || tokens.expires_at - EXPIRY_MARGIN_MS > env.now());
  if (config.flow === "client_credentials") {
    // A machine identity has no refresh token: it simply asks again.
    if (tokens && fresh && !force) return tokens.access_token;
    try {
      const as = await discover(config, baseUrl, env);
      const { client, auth } = await clientFor(config, as, secrets, env);
      return await clientCredentialsToken(as, client, auth, config, secrets, env);
    } catch {
      await secrets.delete("tokens");
      return null;
    }
  }
  if (!tokens) return null;
  if (fresh && !force) return tokens.access_token;
  if (!tokens.refresh_token) return force ? null : tokens.access_token;
  try {
    const as = await discover(config, baseUrl, env);
    const { client, auth } = await clientFor(config, as, secrets, env);
    const dpop = await dpopHandle(config, secrets);
    const refreshToken = tokens.refresh_token;
    const next = await withNonce(async () => {
      const response = await oauth.refreshTokenGrantRequest(as, client, auth, refreshToken, {
        ...requestOptions(env, as.issuer, undefined, dpop),
        additionalParameters: audienceParams(config),
      });
      return oauth.processRefreshTokenResponse(as, client, response);
    });
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

/**
 * A request to the service with a DPoP-bound token: the token travels as
 * `Authorization: DPoP …` with a fresh proof of the key for this method and
 * URL (RFC 9449 §7). A nonce request is answered once; any other challenge
 * comes back as the response it was, so the host's 401 handling still runs.
 */
export async function dpopRequest(
  config: OAuthConfig,
  secrets: OAuthSecrets,
  env: OAuthEnv,
  token: string,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const dpop = await dpopHandle(config, secrets);
  const url = new URL(
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
  );
  const headers = new Headers(init?.headers);
  headers.delete("authorization");
  try {
    return await withNonce(() =>
      oauth.protectedResourceRequest(
        token,
        init?.method ?? "GET",
        url,
        headers,
        init?.body as oauth.ProtectedResourceRequestBody | undefined,
        {
          ...requestOptions(env, url.href, init?.signal ?? undefined, dpop),
          [oauth.customFetch]: (u: string, o: RequestInit) =>
            env.fetch(u, { ...o, redirect: "error" }),
        },
      ),
    );
  } catch (err) {
    if (err instanceof oauth.WWWAuthenticateChallengeError) return err.response;
    throw err;
  }
}
