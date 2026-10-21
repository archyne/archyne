/**
 * A connection: a named, non-secret description of a model service, shared
 * by the page (which edits it) and the host process (which calls it).
 *
 * Nothing here is secret. A key, a password or a token is stored by the host
 * alone, under the connection's id and a field name (`SECRET_FIELDS`), and is
 * never sent back to the page — see AUTH.local.md, "The one rule".
 */

/**
 * The dialect a service speaks (see `dialects.ts`). The first five were
 * decided together (AUTH.local.md, 2026-10-18); Alibaba Cloud followed.
 */
export type Protocol = "openai" | "anthropic" | "bedrock" | "vertex" | "azure" | "alibaba";

export const IMPLEMENTED_PROTOCOLS: readonly Protocol[] = [
  "openai",
  "azure",
  "anthropic",
  "bedrock",
  "vertex",
  "alibaba",
];

export type AuthConfig =
  | { type: "none" }
  /** A key in a header: `Authorization: Bearer …`, `api-key: …`, `x-api-key: …`. */
  | { type: "header"; name: string; prefix?: string }
  /** HTTP Basic; the password is the secret. */
  | { type: "basic"; username: string }
  /** OAuth for a person signing in (AUTH.local.md, phase 2). */
  | OAuthConfig
  /**
   * AWS Signature Version 4: every request signed with an access key, for
   * Amazon Bedrock and anything else behind AWS IAM. The key id, the secret
   * and an optional session token are secrets.
   */
  | { type: "sigv4"; region: string; service?: string };

/**
 * OAuth where a person signs in. The host runs the flow and keeps the tokens;
 * the page only ever learns whether someone is signed in.
 */
export interface OAuthConfig {
  type: "oauth";
  /**
   * `authorization_code`: the system browser opens, the person signs in, and
   * the answer comes back to a loopback port (RFC 8252). `device_code`: the
   * person types a short code on another page (RFC 8628) — for identity
   * providers that refuse loopback redirects. `client_credentials`: no
   * person at all — the connection authenticates as itself (a machine
   * identity, a service principal). `jwt_bearer`: no person either — the
   * identity is an assertion signed with a private key (RFC 7523 §2.1), as a
   * Google service account proves itself.
   */
  flow: "authorization_code" | "device_code" | "client_credentials" | "jwt_bearer";
  /** The authorization server; when empty, found from the service (RFC 9728). */
  issuer?: string;
  /** Empty with `register`, which asks the server for one (RFC 7591). */
  clientId?: string;
  /**
   * For `jwt_bearer`: whom the assertion asks to act for, when not the
   * issuer itself (domain-wide delegation, in Google's terms).
   */
  subject?: string;
  /** Space-separated, as the server expects them. */
  scopes?: string;
  /** RFC 8707 resource indicator, which Entra ID and others need. */
  resource?: string;
  /** The `audience` parameter some providers (Auth0) use instead. */
  audience?: string;
  /** Register a client with the server when there is no client id. */
  register?: boolean;
  /**
   * How the client proves itself at the token endpoint. Default: with the
   * client secret in a Basic header when one is set, and not at all (a
   * public client, PKCE carrying the proof) when none is.
   */
  clientAuth?: ClientAuthMethod;
  /** The JWK key id to put in a `private_key_jwt` assertion, if the server wants one. */
  keyId?: string;
  /**
   * Sender-constrained tokens (DPoP, RFC 9449): every token is bound to a
   * key the host generates and keeps, and every request proves possession
   * of it — so a token copied out of somewhere is useless on its own.
   */
  dpop?: boolean;
}

/**
 * Client authentication at the token endpoint (RFC 6749 §2.3, RFC 7523,
 * RFC 8705). `client_secret_jwt` is left out on purpose: it signs with the
 * shared secret, so it buys nothing over `client_secret_basic` and costs a
 * second way for the secret to be mishandled.
 */
export type ClientAuthMethod =
  "client_secret_basic" | "client_secret_post" | "private_key_jwt" | "tls_client_auth";

export type AuthType = AuthConfig["type"];

export interface Connection {
  /** Stable and generated; secrets are filed under it. */
  id: string;
  label: string;
  /** The API base, e.g. `https://gateway.example.com/v1`. */
  baseUrl: string;
  protocol: Protocol;
  auth: AuthConfig;
  /** Extra, non-secret headers (a tenant id, an organisation). */
  headers?: Record<string, string>;
  /** The model last chosen for this connection. */
  model?: string;
  /**
   * Present a client certificate (mutual TLS) on every request this
   * connection makes — to the service and to its token endpoint. The
   * certificate and its key are secrets (`TLS_SECRET_FIELDS`).
   */
  clientCertificate?: boolean;
}

/** The secrets of a client certificate, whatever the auth method. */
export const TLS_SECRET_FIELDS = ["tlsCert", "tlsKey", "tlsPassphrase", "tlsCa"];

/** Every secret a connection may have filed, for listing and for deleting. */
export function secretFieldsOf(c: Connection): string[] {
  return [...SECRET_FIELDS[c.auth.type], ...TLS_SECRET_FIELDS];
}

/**
 * The secrets each auth method keeps, by the field name they are filed under.
 * For OAuth: an optional client secret the person types, and what the host
 * writes itself — the tokens, and a client the server registered for us.
 */
export const SECRET_FIELDS: Record<AuthType, string[]> = {
  none: [],
  header: ["key"],
  basic: ["password"],
  oauth: ["clientSecret", "privateKey", "tokens", "client", "dpopKey"],
  sigv4: ["accessKeyId", "secretAccessKey", "sessionToken"],
};

/**
 * The secrets a page may set. Only what a person types: a page can never
 * write a token or a registered client, which only the host's own flows
 * produce.
 */
export const PAGE_SETTABLE_SECRETS = new Set([
  "key",
  "password",
  "clientSecret",
  "privateKey",
  "accessKeyId",
  "secretAccessKey",
  "sessionToken",
  ...TLS_SECRET_FIELDS,
]);

/** Header names a connection's extra headers may not set: auth has its own place. */
const RESERVED_HEADERS = new Set(["authorization", "proxy-authorization", "cookie", "host"]);

/** A header name as HTTP allows it (RFC 9110 token). */
export function isHeaderName(name: string): boolean {
  return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name);
}

/** Why a connection cannot be used as it stands, or null when it can. */
export function connectionProblem(c: Connection): string | null {
  if (!IMPLEMENTED_PROTOCOLS.includes(c.protocol)) return "protocol";
  if (c.auth.type === "header" && !isHeaderName(c.auth.name)) return "header-name";
  if (c.auth.type === "basic" && (!c.auth.username || c.auth.username.includes(":"))) {
    return "username";
  }
  if (c.auth.type === "oauth") {
    if (
      !["authorization_code", "device_code", "client_credentials", "jwt_bearer"].includes(
        c.auth.flow,
      )
    ) {
      return "flow";
    }
    if (c.auth.issuer && !isIssuerUrl(c.auth.issuer)) return "issuer";
    // An assertion names its own issuer, from the field or from a key file;
    // it has no client to register or to authenticate.
    if (c.auth.flow === "jwt_bearer") return restProblem(c);
    if (!c.auth.clientId && !c.auth.register) return "client";
    // A machine identity is configured, never registered on the fly; and a
    // key or a certificate proves a client id, so there must be one.
    if (!c.auth.clientId && c.auth.flow === "client_credentials") return "client";
    if (!c.auth.clientId && c.auth.clientAuth && c.auth.clientAuth !== "client_secret_basic") {
      return "client";
    }
  }
  return restProblem(c);
}

/** What is wrong whatever the sign-in: the signature, the transport, the headers. */
function restProblem(c: Connection): string | null {
  if (c.auth.type === "sigv4") {
    if (!/^[a-z]{2}(-[a-z]+)+-\d+$/.test(c.auth.region)) return "region";
    if (c.auth.service !== undefined && !/^[a-z0-9-]+$/.test(c.auth.service)) return "service";
  }
  if (c.clientCertificate && !c.baseUrl.startsWith("https:")) return "tls-https";
  if (
    c.auth.type === "oauth" &&
    c.auth.clientAuth === "tls_client_auth" &&
    !c.clientCertificate
  ) {
    return "tls-client-auth";
  }
  for (const name of Object.keys(c.headers ?? {})) {
    if (!isHeaderName(name) || RESERVED_HEADERS.has(name.toLowerCase())) return "extra-header";
    // The signature's own headers are the signer's to write.
    if (c.auth.type === "sigv4" && name.toLowerCase().startsWith("x-amz-"))
      return "extra-header";
  }
  return null;
}

/**
 * The headers a request to this connection carries, given its secrets.
 *
 * Auth headers are added after the extra ones, so a misconfigured extra
 * header can never shadow the credential.
 */
export function authHeaders(
  c: Connection,
  secrets: Record<string, string | undefined>,
): Record<string, string> {
  const h: Record<string, string> = { ...(c.headers ?? {}) };
  switch (c.auth.type) {
    case "header": {
      const key = secrets.key;
      if (key) h[c.auth.name] = `${c.auth.prefix ?? ""}${key}`;
      break;
    }
    case "basic": {
      const password = secrets.password ?? "";
      h.Authorization = `Basic ${base64(`${c.auth.username}:${password}`)}`;
      break;
    }
    case "oauth": {
      // The host refreshes before it gets here (core.ts); this only reads.
      const tokens = parseTokens(secrets.tokens);
      if (tokens) h.Authorization = `Bearer ${tokens.access_token}`;
      break;
    }
    case "sigv4":
      // Signed per request, over the method, address and body (core.ts).
      break;
    case "none":
      break;
  }
  return h;
}

/** UTF-8 safe Base64, the same in Node and in a browser. */
function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** A fresh connection id: unique enough for a person's list of services. */
export function newConnectionId(): string {
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** `Name: value` per line, as a person types headers. */
export function parseHeaders(text: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    const name = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    if (name) headers[name] = value;
  }
  return headers;
}

export function formatHeaders(headers: Record<string, string> | undefined): string {
  return Object.entries(headers ?? {})
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
}

/** The tokens the host keeps for an OAuth connection, as stored. */
export interface StoredTokens {
  access_token: string;
  /** `bearer`, or `dpop` for a token bound to the host's DPoP key. */
  token_type?: string;
  refresh_token?: string;
  /** Milliseconds since the epoch; absent when the server gave no lifetime. */
  expires_at?: number;
  scope?: string;
}

export function parseTokens(raw: string | undefined): StoredTokens | null {
  if (!raw) return null;
  try {
    const t = JSON.parse(raw) as StoredTokens;
    return typeof t.access_token === "string" && t.access_token ? t : null;
  } catch {
    return null;
  }
}

/** An issuer address: https anywhere, plain http only on loopback (for testing). */
export function isIssuerUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    return (
      url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1")
    );
  } catch {
    return false;
  }
}

/**
 * The secrets a person is asked for, for this configuration — only the ones
 * that will be used, so the form never invites a key nobody reads.
 */
export function wantedSecrets(auth: AuthConfig, clientCertificate = false): string[] {
  return [...wantedAuthSecrets(auth), ...(clientCertificate ? TLS_SECRET_FIELDS : [])];
}

function wantedAuthSecrets(auth: AuthConfig): string[] {
  switch (auth.type) {
    case "header":
      return ["key"];
    case "basic":
      return ["password"];
    case "sigv4":
      return ["accessKeyId", "secretAccessKey", "sessionToken"];
    case "oauth":
      // An assertion is signed with a key; there is no client to prove.
      if (auth.flow === "jwt_bearer") return ["privateKey"];
      switch (auth.clientAuth) {
        case "private_key_jwt":
          return ["privateKey"];
        case "tls_client_auth":
          return [];
        default:
          // Basic, post, or unset: a secret, optional for a public client.
          return ["clientSecret"];
      }
    default:
      return [];
  }
}
