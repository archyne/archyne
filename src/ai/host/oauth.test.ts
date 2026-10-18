// @vitest-environment node
// Node, not jsdom: oauth4webapi hashes and encodes with Node's Uint8Array, and
// jsdom's realm hands it arrays from another realm that lack toBase64.
import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { Connection } from "./connection";
import { AiHost, type HostEvent, type SecretStore } from "./core";
import { authorizationServer, browser, type AsOptions } from "./authServer.testkit";

/**
 * OAuth for people, end to end, against a stand-in authorization server that
 * holds its side of every check: PKCE (S256), state, redirect URI, device-code
 * polling, refresh-token rotation, dynamic registration, revocation, and the
 * service's own Protected Resource Metadata. The "browser" follows the
 * authorization redirect back to the host's loopback listener, as a real one
 * would.
 */

function memorySecrets(): SecretStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: async (k) => data.get(k),
    set: async (k, v) => void data.set(k, v),
    delete: async (k) => void data.delete(k),
  };
}

let servers: Array<{ close(): void }> = [];
afterEach(() => {
  servers.forEach((s) => s.close());
  servers = [];
});

async function setup(asOptions: AsOptions, auth: Partial<Connection["auth"]> = {}) {
  const as = authorizationServer(asOptions);
  await as.start();
  servers.push(as);
  const secrets = memorySecrets();
  let clock = Date.now();
  const host = new AiHost({
    fetch,
    secrets,
    openExternal: browser,
    now: () => clock,
    sleep: async () => {},
  });
  const connection = {
    id: "sso",
    label: "Company gateway",
    baseUrl: `${as.base}/v1`,
    protocol: "openai",
    auth: {
      type: "oauth",
      flow: "authorization_code",
      issuer: as.base,
      clientId: "archyne-test",
      // An API scope only: with `openid` the host demands an ID token, as OIDC
      // requires, and this stand-in issues access tokens.
      scopes: "models.read",
      ...auth,
    },
  } as Connection;
  await host.setConnections([connection]);
  const events: HostEvent[] = [];
  return {
    as,
    host,
    secrets,
    events,
    connection,
    signIn: () => host.signIn("sso", (e) => events.push(e)),
    advance: (ms: number) => (clock += ms),
  };
}

describe("OAuth sign-in", () => {
  it("signs in with an authorization code and PKCE, then calls the service with the token", async () => {
    const { host, events, signIn, as } = await setup({});
    await signIn();
    expect(events.at(-1)).toEqual({ type: "ai:auth", connectionId: "sso", state: "signed-in" });
    expect(await host.authStatus("sso")).toMatchObject({ signedIn: true });
    expect(await host.probe("sso")).toMatchObject({ state: "ok", models: ["secured-model"] });
    // The token exchange carried a verifier the server checked against the challenge.
    expect(
      as.log.find((l) => l.body?.grant_type === "authorization_code")?.body?.code_verifier,
    ).toBeTruthy();
    expect(JSON.stringify(events)).not.toContain(as.issued.accessToken);
  });

  it("refuses an authorization response whose state is not ours", async () => {
    const { host, events, signIn } = await setup({ wrongState: true });
    await signIn();
    expect(events.at(-1)).toMatchObject({ state: "error" });
    expect(await host.authStatus("sso")).toEqual({ signedIn: false });
  });

  it("asked for OpenID Connect, refuses a sign-in that brings no ID token", async () => {
    const { host, events, signIn } = await setup({}, { scopes: "openid models.read" });
    await signIn();
    expect(events.at(-1)).toMatchObject({ state: "error" });
    expect(await host.authStatus("sso")).toEqual({ signedIn: false });
  });

  it("signs in with a device code: shows the code, waits for the person, then holds the token", async () => {
    const { host, events, signIn } = await setup({ pendingPolls: 2 }, { flow: "device_code" });
    await signIn();
    expect(events[0]).toMatchObject({
      type: "ai:auth",
      state: "device-code",
      userCode: "WDJB-MJHT",
    });
    expect(events.at(-1)).toMatchObject({ state: "signed-in" });
    expect(await host.probe("sso")).toMatchObject({ state: "ok" });
  });

  it("finds the authorization server from the service itself when no issuer is set (RFC 9728)", async () => {
    const { host, signIn, as } = await setup({}, { issuer: undefined });
    await signIn();
    expect(as.log.some((l) => l.path === "/.well-known/oauth-protected-resource/v1")).toBe(
      true,
    );
    expect(await host.authStatus("sso")).toMatchObject({ signedIn: true });
  });

  it("registers a client with the server when there is no client id (RFC 7591)", async () => {
    const { host, signIn, as } = await setup({}, { clientId: undefined, register: true });
    await signIn();
    expect(as.registered).toHaveLength(1);
    expect(as.registered[0]).toMatchObject({
      application_type: "native",
      token_endpoint_auth_method: "none",
    });
    expect(await host.authStatus("sso")).toMatchObject({ signedIn: true });
    // A second sign-in reuses the registered client rather than registering again.
    await signIn();
    expect(as.registered).toHaveLength(1);
  });
});

describe("a machine identity (client credentials)", () => {
  const machine = { flow: "client_credentials", clientId: "svc-1" } as const;
  const tokenRequests = (as: {
    log: Array<{ body?: Record<string, string>; clientAuth?: string }>;
  }) => as.log.filter((l) => l.body?.grant_type === "client_credentials");

  it("authenticates with the secret in a Basic header unless told otherwise", async () => {
    const { host, events, signIn, as } = await setup(
      { client: { id: "svc-1", secret: "s3cr3t" } },
      machine,
    );
    await host.setSecret("sso", "clientSecret", "s3cr3t");
    await signIn();
    expect(events.at(-1)).toMatchObject({ state: "signed-in" });
    expect(tokenRequests(as)[0].clientAuth).toBe("basic");
    expect(await host.probe("sso")).toMatchObject({ state: "ok" });
  });

  it("sends the secret in the body when the server wants client_secret_post", async () => {
    const { host, signIn, as } = await setup(
      { client: { id: "svc-1", secret: "s3cr3t" } },
      { ...machine, clientAuth: "client_secret_post" },
    );
    await host.setSecret("sso", "clientSecret", "s3cr3t");
    await signIn();
    expect(tokenRequests(as)[0].clientAuth).toBe("post");
  });

  for (const kind of ["EC P-256", "RSA"] as const) {
    it(`proves itself with a ${kind} key: a signed assertion the server verifies (RFC 7523)`, async () => {
      const pair =
        kind === "RSA"
          ? generateKeyPairSync("rsa", { modulusLength: 2048 })
          : generateKeyPairSync("ec", { namedCurve: "prime256v1" });
      const { host, signIn, as, events } = await setup(
        { client: { id: "svc-1", publicKey: pair.publicKey, keyId: "k-2026" } },
        { ...machine, clientAuth: "private_key_jwt", keyId: "k-2026" },
      );
      await host.setSecret(
        "sso",
        "privateKey",
        pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      );
      await signIn();
      expect(events.at(-1)).toMatchObject({ state: "signed-in" });
      expect(tokenRequests(as)[0].clientAuth).toBe("private_key_jwt");
    });
  }

  it("is refused with the wrong secret, and says so", async () => {
    const { host, events, signIn } = await setup(
      { client: { id: "svc-1", secret: "right" } },
      machine,
    );
    await host.setSecret("sso", "clientSecret", "wrong");
    await signIn();
    expect(events.at(-1)).toMatchObject({ state: "error" });
    expect(await host.authStatus("sso")).toEqual({ signedIn: false });
  });

  it("asks again when its token lapses — there is no refresh token to use", async () => {
    const { host, signIn, as, advance } = await setup(
      { client: { id: "svc-1", secret: "s3cr3t" }, expiresIn: 120 },
      machine,
    );
    await host.setSecret("sso", "clientSecret", "s3cr3t");
    await signIn();
    advance(90_000);
    expect(await host.probe("sso")).toMatchObject({ state: "ok" });
    expect(tokenRequests(as)).toHaveLength(2);
    expect(as.log.some((l) => l.body?.grant_type === "refresh_token")).toBe(false);
  });

  it("needs a client id: a machine identity is configured, never registered on the fly", async () => {
    const { host } = await setup(
      {},
      { flow: "client_credentials", clientId: undefined, register: true },
    );
    expect(await host.probe("sso")).toEqual({ state: "invalid", problem: "client" });
  });
});

describe("an identity proven by a signed assertion (JWT bearer, RFC 7523 §2.1)", () => {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const identity = {
    issuer: "diagrams@acme-ai.iam.gserviceaccount.com",
    publicKey: pair.publicKey,
  };
  const assertions = (as: { log: Array<{ body?: Record<string, string> }> }) =>
    as.log.filter(
      (l) => l.body?.grant_type === "urn:ietf:params:oauth:grant-type:jwt-bearer",
    ) as Array<{ body: Record<string, string>; assertion?: Record<string, unknown> }>;

  it("signs an assertion the server verifies, and calls the service with what it issues", async () => {
    const { host, events, signIn, as } = await setup(
      { assertion: { ...identity, keyId: "k-sa-1" } },
      {
        flow: "jwt_bearer",
        clientId: identity.issuer,
        keyId: "k-sa-1",
        scopes: "https://www.googleapis.com/auth/cloud-platform",
      },
    );
    await host.setSecret("sso", "privateKey", pem);
    await signIn();
    expect(events.at(-1)).toMatchObject({ state: "signed-in" });
    const [request] = assertions(as);
    expect(request.assertion).toMatchObject({
      iss: identity.issuer,
      sub: identity.issuer,
      aud: `${as.base}/token`,
      scope: "https://www.googleapis.com/auth/cloud-platform",
    });
    // RFC 7523 carries the scope as a parameter too; no client to name.
    expect(request.body.scope).toBe("https://www.googleapis.com/auth/cloud-platform");
    expect(request.body).not.toHaveProperty("client_id");
    expect(await host.probe("sso")).toMatchObject({ state: "ok" });
  });

  it("takes a Google service account key file as it is: the key, the identity and the key id in it", async () => {
    const { host, events, signIn, as } = await setup(
      { assertion: { ...identity, keyId: "0123abcd" } },
      { flow: "jwt_bearer", clientId: undefined, scopes: "models.read" },
    );
    await host.setSecret(
      "sso",
      "privateKey",
      JSON.stringify({
        type: "service_account",
        project_id: "acme-ai",
        private_key_id: "0123abcd",
        private_key: pem,
        client_email: identity.issuer,
        token_uri: "https://oauth2.googleapis.com/token",
      }),
    );
    await signIn();
    expect(events.at(-1)).toMatchObject({ state: "signed-in" });
    expect(assertions(as)[0].assertion).toMatchObject({ iss: identity.issuer });
  });

  it("asks to act for someone else when a subject is set", async () => {
    const { host, signIn, as } = await setup(
      { assertion: identity },
      { flow: "jwt_bearer", clientId: identity.issuer, subject: "dario@acme.example" },
    );
    await host.setSecret("sso", "privateKey", pem);
    await signIn();
    expect(assertions(as)[0].assertion).toMatchObject({ sub: "dario@acme.example" });
  });

  it("signs a new assertion when the token lapses, never reusing one", async () => {
    const { host, signIn, as, advance } = await setup(
      { assertion: identity, expiresIn: 120 },
      { flow: "jwt_bearer", clientId: identity.issuer },
    );
    await host.setSecret("sso", "privateKey", pem);
    await signIn();
    advance(90_000);
    expect(await host.probe("sso")).toMatchObject({ state: "ok" });
    const [first, second] = assertions(as);
    expect(second.assertion?.jti).not.toBe(first.assertion?.jti);
    expect(as.log.some((l) => l.body?.grant_type === "refresh_token")).toBe(false);
  });

  it("is refused when signed with another key", async () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const { host, events, signIn } = await setup(
      { assertion: identity },
      { flow: "jwt_bearer", clientId: identity.issuer },
    );
    await host.setSecret(
      "sso",
      "privateKey",
      other.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    );
    await signIn();
    expect(events.at(-1)).toMatchObject({ state: "error" });
    expect(await host.authStatus("sso")).toEqual({ signedIn: false });
  });
});

describe("DPoP: tokens bound to a key the host keeps (RFC 9449)", () => {
  const tokenProofs = (as: { log: Array<{ path: string; dpop?: string }> }) =>
    as.log.filter((l) => l.path === "/token" && l.dpop).map((l) => l.dpop);

  it("binds the code and the token to the host's key, and proves it on every call", async () => {
    const { host, events, signIn, as } = await setup({}, { dpop: true });
    await signIn();
    expect(events.at(-1)).toMatchObject({ state: "signed-in" });
    const [jkt] = tokenProofs(as);
    expect(jkt).toMatch(/^[\w-]{43}$/);
    expect(as.log.find((l) => l.path === "/authorize")?.body?.dpop_jkt).toBe(jkt);
    expect(await host.probe("sso")).toMatchObject({ state: "ok" });
    expect(as.log.filter((l) => l.path === "/v1/models").at(-1)?.dpop).toBe(jkt);
  });

  it("is useless as a plain bearer token", async () => {
    const { signIn, as } = await setup({}, { dpop: true });
    await signIn();
    const stolen = await fetch(`${as.base}/v1/models`, {
      headers: { Authorization: `Bearer ${as.issued.accessToken}` },
    });
    expect(stolen.status).toBe(401);
  });

  it("answers a server that asks for a nonce, once", async () => {
    const { host, events, signIn, as } = await setup({ dpopNonce: "n-2026" }, { dpop: true });
    await signIn();
    expect(events.at(-1)).toMatchObject({ state: "signed-in" });
    const proofs = tokenProofs(as);
    expect(proofs[0]).toBe("use_dpop_nonce");
    expect(proofs[1]).toMatch(/^[\w-]{43}$/);
    expect(await host.probe("sso")).toMatchObject({ state: "ok" });
  });

  it("refreshes with the same key", async () => {
    const { host, signIn, as, advance } = await setup({ expiresIn: 120 }, { dpop: true });
    await signIn();
    advance(90_000);
    expect(await host.probe("sso")).toMatchObject({ state: "ok" });
    const proofs = tokenProofs(as);
    expect(as.log.some((l) => l.body?.grant_type === "refresh_token")).toBe(true);
    expect(new Set(proofs).size).toBe(1);
  });

  it("keeps the key with the tokens, so a restart can still use them", async () => {
    const { signIn, secrets, connection, as } = await setup({}, { dpop: true });
    await signIn();
    const restarted = new AiHost({ fetch, secrets, openExternal: browser });
    await restarted.setConnections([connection]);
    expect(await restarted.probe("sso")).toMatchObject({ state: "ok" });
    expect(new Set(as.log.filter((l) => l.dpop).map((l) => l.dpop)).size).toBe(1);
  });

  it("binds a machine identity's token too", async () => {
    const { host, signIn, as } = await setup(
      { client: { id: "svc-1", secret: "s3cr3t" } },
      { flow: "client_credentials", clientId: "svc-1", dpop: true },
    );
    await host.setSecret("sso", "clientSecret", "s3cr3t");
    await signIn();
    expect(tokenProofs(as)).toHaveLength(1);
    expect(await host.probe("sso")).toMatchObject({ state: "ok" });
  });

  it("binds a device-code sign-in", async () => {
    const { host, signIn, as } = await setup(
      { pendingPolls: 1 },
      { flow: "device_code", dpop: true },
    );
    await signIn();
    expect(tokenProofs(as).length).toBeGreaterThan(0);
    expect(await host.probe("sso")).toMatchObject({ state: "ok" });
  });
});

describe("tokens after sign-in", () => {
  it("refreshes a token about to lapse, and keeps the rotated refresh token", async () => {
    const { host, signIn, as, advance, secrets } = await setup({ expiresIn: 120 });
    await signIn();
    advance(90_000); // inside the minute's margin before expiry
    expect(await host.probe("sso")).toMatchObject({ state: "ok" });
    expect(as.log.filter((l) => l.body?.grant_type === "refresh_token")).toHaveLength(1);
    const stored = JSON.parse(
      [...secrets.data.entries()].find(([k]) => k.endsWith(".tokens"))![1],
    );
    expect(stored.refresh_token).toBe(as.issued.refreshToken);
    expect(stored.refresh_token).toMatch(/-2$/);
  });

  it("refreshes once and retries when the service answers 401", async () => {
    const { host, signIn, as } = await setup({});
    await signIn();
    as.expireAccessToken();
    expect(await host.probe("sso")).toMatchObject({ state: "ok" });
    expect(as.log.filter((l) => l.body?.grant_type === "refresh_token")).toHaveLength(1);
  });

  it("signs out: revokes at the server and forgets the tokens", async () => {
    const { host, signIn, as } = await setup({});
    await signIn();
    await host.signOut("sso");
    expect(as.log.some((l) => l.path === "/revoke")).toBe(true);
    expect(await host.authStatus("sso")).toEqual({ signedIn: false });
    expect(await host.probe("sso")).toMatchObject({ state: "http", status: 401 });
  });

  it("never lets the page write a token", async () => {
    const { host } = await setup({});
    await expect(
      host.setSecret("sso", "tokens", '{"access_token":"planted"}'),
    ).rejects.toThrow();
    await expect(host.setSecret("sso", "client", "{}")).rejects.toThrow();
  });
});
