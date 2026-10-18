import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

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
}

export function authorizationServer(options: AsOptions = {}) {
  const tag = randomBytes(12).toString("hex");
  const log: Array<{ path: string; body?: Record<string, string> }> = [];
  let base = "";
  const codes = new Map<string, { challenge: string; redirectUri: string; clientId: string }>();
  let accessToken = "";
  let refreshToken = "";
  let issued = 0;
  let polls = 0;
  const registered: Array<Record<string, unknown>> = [];

  const issue = (res: ServerResponse) => {
    issued += 1;
    // Long and unique, so a test that searches a profile for them cannot
    // match a short string by accident (`rt-1` sits inside `start-1`).
    accessToken = `at-${tag}-${issued}`;
    refreshToken = `rt-${tag}-${issued}`;
    json(res, 200, {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: "Bearer",
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

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", base);
    const body = req.method === "POST" ? await form(req) : undefined;
    log.push({ path: url.pathname, body });
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
          return issue(res);
        }
        if (grant === "urn:ietf:params:oauth:grant-type:device_code") {
          polls += 1;
          if (polls <= (options.pendingPolls ?? 0))
            return json(res, 400, { error: "authorization_pending" });
          return issue(res);
        }
        if (grant === "refresh_token") {
          if (body?.refresh_token !== refreshToken)
            return json(res, 400, { error: "invalid_grant" });
          return issue(res);
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
        if (req.headers.authorization !== `Bearer ${accessToken}` || !accessToken) {
          res.writeHead(401, { "WWW-Authenticate": "Bearer" }).end();
          return;
        }
        return json(res, 200, { data: [{ id: "secured-model" }] });
      }
      default:
        res.writeHead(404).end();
    }
  });

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
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
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
