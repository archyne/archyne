// @vitest-environment node
// Node, not jsdom: oauth4webapi hashes and encodes with Node's Uint8Array, and
// jsdom's realm hands it arrays from another realm that lack toBase64.
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
