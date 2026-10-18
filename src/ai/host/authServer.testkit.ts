import { createHash, createPublicKey, randomBytes, verify, type KeyObject } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import type { TLSSocket } from "node:tls";
import type { TestPki } from "./tls.testkit";

/**
 * A stand-in OAuth authorization server, and a browser that consents at once.
 *
 * Shared by the unit tests (oauth.test.ts) and the end-to-end tests of the
 * desktop app and the VS Code extension. Not part of the app: nothing under
 * src imports it outside a test.
 *
 * It holds its side of every check — PKCE (S256), state, redirect URI,
 * device-code polling, refresh-token rotation, dynamic registration,
 * revocation — and doubles as the protected service, with its own Protected
 * Resource Metadata (RFC 9728) and a /v1 API that wants the current token.
 */

export interface AsOptions {
  wrongState?: boolean;
  pendingPolls?: number;
  expiresIn?: number;
  /**
   * The machine client the client-credentials grant accepts, and how it may
   * prove itself: its secret (Basic or in the body), or an assertion signed
   * with the private half of `publicKey` (private_key_jwt).
   */
  client?: {
    id: string;
    secret?: string;
    publicKey?: KeyObject;
    keyId?: string;
    /** The certificate subject CN that proves this client (tls_client_auth, RFC 8705). */
    certificateCn?: string;
  };
  /**
   * Serve over HTTPS with this PKI's server certificate, asking every caller
   * for a client certificate and trusting only the PKI's CA for it.
   */
  tls?: TestPki;
  /** What the protected /v1 API wants: the current token (default), or a client certificate alone. */
  serviceAuth?: "bearer" | "certificate";
  /** Insist on this DPoP nonce in token-endpoint proofs (RFC 9449 §8). */
  dpopNonce?: string;
}

/** Which client authentication a token request used, as the server judged it. */
export type ClientAuthSeen =
  "basic" | "post" | "private_key_jwt" | "tls_client_auth" | "none" | "refused";

/** The CN of a verified client certificate on this request, or null. */
function peerCn(req: IncomingMessage): string | null {
  const socket = req.socket as Partial<TLSSocket>;
  if (!socket.authorized || !socket.getPeerCertificate) return null;
  return String(socket.getPeerCertificate().subject?.CN ?? "") || null;
}

export function authorizationServer(options: AsOptions = {}) {
  const tag = randomBytes(12).toString("hex");
  const log: Array<{
    path: string;
    body?: Record<string, string>;
    clientAuth?: ClientAuthSeen;
    /** The DPoP key thumbprint a proof carried, or why it was refused. */
    dpop?: string;
    /** The CN of the verified client certificate the request came with, if any. */
    peer?: string | null;
  }> = [];
  let base = "";
  const codes = new Map<string, { challenge: string; redirectUri: string; clientId: string }>();
  let accessToken = "";
  let refreshToken = "";
  let issued = 0;
  let polls = 0;
  const registered: Array<Record<string, unknown>> = [];

  /** The DPoP key thumbprint the current tokens are bound to, if any. */
  let boundJkt: string | null = null;
  const issue = (res: ServerResponse, jkt: string | null = null) => {
    issued += 1;
    boundJkt = jkt;
    // Long and unique, so a test that searches a profile for them cannot
    // match a short string by accident (`rt-1` sits inside `start-1`).
    accessToken = `at-${tag}-${issued}`;
    refreshToken = `rt-${tag}-${issued}`;
    json(res, 200, {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: jkt ? "DPoP" : "Bearer",
      expires_in: options.expiresIn ?? 3600,
    });
  };

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };

  const form = (req: IncomingMessage) =>
    new Promise<Record<string, string>>((resolve) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const type = req.headers["content-type"] ?? "";
        resolve(
          type.includes("json")
            ? (JSON.parse(raw || "{}") as Record<string, string>)
            : Object.fromEntries(new URLSearchParams(raw)),
        );
      });
    });

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", base);
    const body = req.method === "POST" ? await form(req) : undefined;
    log.push({ path: url.pathname, body, peer: peerCn(req) });
    switch (url.pathname) {
      case "/.well-known/openid-configuration":
        return json(res, 200, {
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          device_authorization_endpoint: `${base}/device_authorization`,
          registration_endpoint: `${base}/register`,
          revocation_endpoint: `${base}/revoke`,
          code_challenge_methods_supported: ["S256"],
          authorization_response_iss_parameter_supported: true,
        });
      case "/.well-known/oauth-protected-resource/v1":
        return json(res, 200, { resource: `${base}/v1`, authorization_servers: [base] });
      case "/authorize": {
        const p = url.searchParams;
        log[log.length - 1].body = Object.fromEntries(p);
        if (p.get("code_challenge_method") !== "S256")
          return json(res, 400, { error: "invalid_request" });
        const code = `code-${codes.size + 1}`;
        codes.set(code, {
          challenge: p.get("code_challenge") ?? "",
          redirectUri: p.get("redirect_uri") ?? "",
          clientId: p.get("client_id") ?? "",
        });
        const back = new URL(p.get("redirect_uri") ?? "");
        back.searchParams.set("code", code);
        back.searchParams.set("state", options.wrongState ? "forged" : (p.get("state") ?? ""));
        back.searchParams.set("iss", base);
        res.writeHead(302, { Location: back.href }).end();
        return;
      }
      case "/token": {
        const grant = body?.grant_type;
        // DPoP at the token endpoint: a valid proof binds what is issued.
        let jkt: string | null = null;
        const proof = req.headers.dpop as string | undefined;
        if (proof) {
          const checked = checkProof(proof, "POST", `${base}/token`, {
            nonce: options.dpopNonce,
          });
          log[log.length - 1].dpop = checked.jkt ?? checked.error;
          if (checked.error === "use_dpop_nonce") {
            res.writeHead(400, {
              "Content-Type": "application/json",
              "DPoP-Nonce": options.dpopNonce ?? "",
            });
            res.end(
              JSON.stringify({ error: "use_dpop_nonce", error_description: "nonce required" }),
            );
            return;
          }
          if (!checked.jkt) return json(res, 400, { error: "invalid_dpop_proof" });
          jkt = checked.jkt;
        }
        // A refresh of a bound token must prove the same key.
        if (grant === "refresh_token" && boundJkt && jkt !== boundJkt) {
          return json(res, 400, { error: "invalid_dpop_proof" });
        }
        if (grant === "authorization_code") {
          const pending = codes.get(body?.code ?? "");
          codes.delete(body?.code ?? "");
          const challenge = createHash("sha256")
            .update(body?.code_verifier ?? "")
            .digest("base64url");
          if (
            !pending ||
            pending.challenge !== challenge ||
            pending.redirectUri !== body?.redirect_uri
          ) {
            return json(res, 400, { error: "invalid_grant" });
          }
          return issue(res, jkt);
        }
        if (grant === "urn:ietf:params:oauth:grant-type:device_code") {
          polls += 1;
          if (polls <= (options.pendingPolls ?? 0))
            return json(res, 400, { error: "authorization_pending" });
          return issue(res, jkt);
        }
        if (grant === "client_credentials") {
          const seen = judgeClient(req, body ?? {}, options.client, base);
          log[log.length - 1].clientAuth = seen;
          if (seen === "refused" || seen === "none")
            return json(res, 401, { error: "invalid_client" });
          return issue(res, jkt);
        }
        if (grant === "refresh_token") {
          if (body?.refresh_token !== refreshToken)
            return json(res, 400, { error: "invalid_grant" });
          return issue(res, jkt);
        }
        return json(res, 400, { error: "unsupported_grant_type" });
      }
      case "/device_authorization":
        return json(res, 200, {
          device_code: "dc-1",
          user_code: "WDJB-MJHT",
          verification_uri: `${base}/device`,
          expires_in: 600,
          interval: 1,
        });
      case "/register":
        registered.push(body ?? {});
        return json(res, 201, { client_id: `registered-${registered.length}` });
      case "/revoke":
        return json(res, 200, {});
      case "/v1/models": {
        if (options.serviceAuth === "certificate") {
          if (!peerCn(req)) {
            res.writeHead(401).end("client certificate required");
            return;
          }
          return json(res, 200, { data: [{ id: "secured-model" }] });
        }
        if (boundJkt) {
          // A DPoP-bound token is good only with a proof of its key, for this
          // request, carrying the token's hash; as a bearer token it is refused.
          const proof = req.headers.dpop as string | undefined;
          const checked = proof
            ? checkProof(proof, req.method ?? "GET", `${base}${url.pathname}`, {
                ath: createHash("sha256").update(accessToken).digest("base64url"),
              })
            : { error: "no proof" };
          log[log.length - 1].dpop = checked.jkt ?? checked.error;
          if (req.headers.authorization !== `DPoP ${accessToken}` || checked.jkt !== boundJkt) {
            res.writeHead(401, { "WWW-Authenticate": 'DPoP error="invalid_token"' }).end();
            return;
          }
          return json(res, 200, { data: [{ id: "secured-model" }] });
        }
        if (req.headers.authorization !== `Bearer ${accessToken}` || !accessToken) {
          res.writeHead(401, { "WWW-Authenticate": "Bearer" }).end();
          return;
        }
        return json(res, 200, { data: [{ id: "secured-model" }] });
      }
      default:
        res.writeHead(404).end();
    }
  };
  const server = options.tls
    ? createHttpsServer(
        {
          cert: options.tls.server.cert,
          key: options.tls.server.key,
          ca: options.tls.ca,
          requestCert: true,
          // Judged per request, so a missing certificate is a 401 a test can
          // read rather than a handshake that just fails.
          rejectUnauthorized: false,
        },
        handler,
      )
    : createServer(handler);

  return {
    log,
    registered,
    get base() {
      return base;
    },
    /** The tokens issued last, so a test can look for them where they must not be. */
    get issued() {
      return { accessToken, refreshToken };
    },
    /** The service forgets the current access token, as after an early revocation. */
    expireAccessToken() {
      accessToken = "revoked-at-the-server";
    },
    async start() {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      base = `${options.tls ? "https" : "http"}://127.0.0.1:${(server.address() as AddressInfo).port}`;
    },
    close() {
      server.close();
      server.closeAllConnections();
    },
  };
}

/** A browser that consents at once: follows the authorization redirect to the loopback. */
export async function browser(url: string): Promise<void> {
  if (!url.includes("/authorize")) return; // a device-code page: the person types the code
  const consent = await fetch(url, { redirect: "manual" });
  const back = consent.headers.get("location");
  if (back) await fetch(back);
}

/**
 * How a token request authenticated its client, checked the way a server
 * must: the secret compared, or the assertion's signature, issuer, subject,
 * audience and expiry verified against the client's public key (RFC 7523).
 */
function judgeClient(
  req: IncomingMessage,
  body: Record<string, string>,
  client: AsOptions["client"],
  issuer: string,
): ClientAuthSeen {
  if (!client) return "refused";
  const header = req.headers.authorization ?? "";
  const cn = peerCn(req);
  if (
    !header &&
    body.client_secret === undefined &&
    body.client_assertion === undefined &&
    body.client_id === client.id &&
    client.certificateCn
  ) {
    return cn === client.certificateCn ? "tls_client_auth" : "refused";
  }
  if (header.startsWith("Basic ")) {
    const [id, secret] = Buffer.from(header.slice(6), "base64")
      .toString("utf8")
      .split(":")
      .map(decodeURIComponent);
    return id === client.id && !!client.secret && secret === client.secret
      ? "basic"
      : "refused";
  }
  if (body.client_secret !== undefined) {
    return body.client_id === client.id && body.client_secret === client.secret
      ? "post"
      : "refused";
  }
  if (body.client_assertion_type === "urn:ietf:params:oauth:client-assertion-type:jwt-bearer") {
    if (!client.publicKey) return "refused";
    const [h, p, sig] = (body.client_assertion ?? "").split(".");
    const head = JSON.parse(Buffer.from(h, "base64url").toString()) as {
      alg: string;
      kid?: string;
    };
    const claims = JSON.parse(Buffer.from(p, "base64url").toString()) as {
      iss: string;
      sub: string;
      aud: string | string[];
      exp: number;
      jti?: string;
    };
    const signed = verify(
      "sha256", // RS256 and ES256, the two the tests sign with
      Buffer.from(`${h}.${p}`),
      { key: client.publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(sig, "base64url"),
    );
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    const ok =
      signed &&
      claims.iss === client.id &&
      claims.sub === client.id &&
      audiences.some((a) => a === issuer || a === `${issuer}/token`) &&
      claims.exp * 1000 > Date.now() &&
      !!claims.jti &&
      (!client.keyId || head.kid === client.keyId);
    return ok ? "private_key_jwt" : "refused";
  }
  return "none";
}

/** RFC 7638 thumbprint of an EC public JWK: the required members in order, hashed. */
function thumbprint(jwk: { crv: string; kty: string; x: string; y: string }): string {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  return createHash("sha256").update(canonical).digest("base64url");
}

const seenJti = new Set<string>();

/**
 * Check a DPoP proof as a server must (RFC 9449 §4.3): its type, its key and
 * signature, the method and URL it was made for, its age, a jti not seen
 * before, the nonce when one is required, and the token hash on a resource
 * request. Returns the key's thumbprint, or why it was refused.
 */
function checkProof(
  proof: string,
  method: string,
  url: string,
  want: { nonce?: string; ath?: string },
): { jkt?: string; error?: string } {
  const [h, p, sig] = proof.split(".");
  const head = JSON.parse(Buffer.from(h, "base64url").toString()) as {
    typ?: string;
    alg?: string;
    jwk?: { crv: string; kty: string; x: string; y: string };
  };
  const claims = JSON.parse(Buffer.from(p, "base64url").toString()) as {
    htm?: string;
    htu?: string;
    iat?: number;
    jti?: string;
    nonce?: string;
    ath?: string;
  };
  if (head.typ !== "dpop+jwt" || head.alg !== "ES256" || !head.jwk) return { error: "header" };
  const key = createPublicKey({ key: head.jwk, format: "jwk" });
  const signed = verify(
    "sha256",
    Buffer.from(`${h}.${p}`),
    { key, dsaEncoding: "ieee-p1363" },
    Buffer.from(sig, "base64url"),
  );
  if (!signed) return { error: "signature" };
  if (claims.htm !== method || claims.htu !== url) return { error: "htm/htu" };
  if (!claims.iat || Math.abs(Date.now() / 1000 - claims.iat) > 300) return { error: "iat" };
  if (!claims.jti || seenJti.has(claims.jti)) return { error: "jti" };
  if (want.nonce && claims.nonce !== want.nonce) return { error: "use_dpop_nonce" };
  if (want.ath && claims.ath !== want.ath) return { error: "ath" };
  seenJti.add(claims.jti);
  return { jkt: thumbprint(head.jwk) };
}
