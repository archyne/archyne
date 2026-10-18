/**
 * A connection: a named, non-secret description of a model service, shared
 * by the page (which edits it) and the host process (which calls it).
 *
 * Nothing here is secret. A key, a password or a token is stored by the host
 * alone, under the connection's id and a field name (`SECRET_FIELDS`), and is
 * never sent back to the page — see AUTH.local.md, "The one rule".
 */

/**
 * The dialect a service speaks. Only `openai` is implemented; the others are
 * decided (AUTH.local.md, 2026-10-18) and named now so stored connections
 * never have to be migrated when they arrive.
 */
export type Protocol = "openai" | "anthropic" | "bedrock" | "vertex" | "azure";

export const IMPLEMENTED_PROTOCOLS: readonly Protocol[] = ["openai"];

export type AuthConfig =
  | { type: "none" }
  /** A key in a header: `Authorization: Bearer …`, `api-key: …`, `x-api-key: …`. */
  | { type: "header"; name: string; prefix?: string }
  /** HTTP Basic; the password is the secret. */
  | { type: "basic"; username: string };

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
}

/** The secret each auth method needs, by the field name it is filed under. */
export const SECRET_FIELDS: Record<AuthType, string[]> = {
  none: [],
  header: ["key"],
  basic: ["password"],
};

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
  for (const name of Object.keys(c.headers ?? {})) {
    if (!isHeaderName(name) || RESERVED_HEADERS.has(name.toLowerCase())) return "extra-header";
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
