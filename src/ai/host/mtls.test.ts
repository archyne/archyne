// @vitest-environment node
// Node, not jsdom: node:https and oauth4webapi need Node's own realm.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { authorizationServer, type AsOptions } from "./authServer.testkit";
import type { Connection } from "./connection";
import { AiHost, type HostEvent, type SecretStore } from "./core";
import { mtlsFetch } from "./mtls";
import { testPki, type TestPki } from "./tls.testkit";

/**
 * Mutual TLS against a stand-in server that asks every caller for a client
 * certificate and trusts one CA: the certificate opens the service, one from
 * another CA does not, and a token endpoint can authenticate the client by
 * its certificate alone (tls_client_auth, RFC 8705).
 */

let pki: TestPki;
beforeAll(async () => {
  pki = await testPki("CN=svc-1");
});

let servers: Array<{ close(): void }> = [];
afterEach(() => {
  servers.forEach((s) => s.close());
  servers = [];
});

function memorySecrets(): SecretStore {
  const data = new Map<string, string>();
  return {
    get: async (k) => data.get(k),
    set: async (k, v) => void data.set(k, v),
    delete: async (k) => void data.delete(k),
  };
}

async function setup(as: AsOptions, connection: Partial<Connection>, cert = () => pki.client) {
  const server = authorizationServer({ tls: pki, ...as });
  await server.start();
  servers.push(server);
  const host = new AiHost({ fetch, secrets: memorySecrets() });
  await host.setConnections([
    {
      id: "m",
      label: "Gateway behind mTLS",
      baseUrl: `${server.base}/v1`,
      protocol: "openai",
      auth: { type: "none" },
      clientCertificate: true,
      ...connection,
    } as Connection,
  ]);
  const { cert: pem, key } = cert();
  await host.setSecret("m", "tlsCert", pem);
  await host.setSecret("m", "tlsKey", key);
  // The stand-in's server certificate is signed by the test CA, which Node
  // does not know: the same as a company CA, and given the same way.
  await host.setSecret("m", "tlsCa", pki.ca);
  return { server, host };
}

describe("a client certificate", () => {
  it("opens a service that authenticates the client by certificate", async () => {
    const { host } = await setup({ serviceAuth: "certificate" }, {});
    expect(await host.probe("m")).toMatchObject({ state: "ok", models: ["secured-model"] });
  });

  it("from another CA is refused by the service", async () => {
    const { host } = await setup({ serviceAuth: "certificate" }, {}, () => pki.stranger);
    expect(await host.probe("m")).toMatchObject({ state: "http", status: 401 });
  });

  it("is reported as missing rather than sent without", async () => {
    const server = authorizationServer({ tls: pki, serviceAuth: "certificate" });
    await server.start();
    servers.push(server);
    const host = new AiHost({ fetch, secrets: memorySecrets() });
    await host.setConnections([
      {
        id: "m",
        label: "x",
        baseUrl: `${server.base}/v1`,
        protocol: "openai",
        auth: { type: "none" },
        clientCertificate: true,
      },
    ]);
    const events: HostEvent[] = [];
    await host.chat("r1", "m", "secured-model", [{ role: "user", content: "x" }], (e) =>
      events.push(e),
    );
    expect(events.at(-1)).toMatchObject({ type: "ai:error" });
    expect(server.log.some((l) => l.path.startsWith("/v1"))).toBe(false);
  });

  it("authenticates a machine client at the token endpoint (tls_client_auth)", async () => {
    const { host, server } = await setup(
      { client: { id: "svc-1", certificateCn: "svc-1" } },
      {
        auth: {
          type: "oauth",
          flow: "client_credentials",
          issuer: undefined,
          clientId: "svc-1",
          clientAuth: "tls_client_auth",
        },
      },
    );
    // The issuer is the stand-in itself; it runs over the same mTLS transport.
    await host.setConnections([
      {
        id: "m",
        label: "Gateway behind mTLS",
        baseUrl: `${server.base}/v1`,
        protocol: "openai",
        auth: {
          type: "oauth",
          flow: "client_credentials",
          issuer: server.base,
          clientId: "svc-1",
          clientAuth: "tls_client_auth",
        },
        clientCertificate: true,
      },
    ]);
    const events: HostEvent[] = [];
    await host.signIn("m", (e) => events.push(e));
    expect(events.at(-1)).toMatchObject({ state: "signed-in" });
    expect(
      server.log.find((l) => l.body?.grant_type === "client_credentials")?.clientAuth,
    ).toBe("tls_client_auth");
    expect(await host.probe("m")).toMatchObject({ state: "ok" });
  });
});

describe("what a client certificate will not do", () => {
  it("go over plain http", async () => {
    const host = new AiHost({ fetch, secrets: memorySecrets() });
    await host.setConnections([
      {
        id: "m",
        label: "x",
        baseUrl: "http://127.0.0.1:1/v1",
        protocol: "openai",
        auth: { type: "none" },
        clientCertificate: true,
      },
    ]);
    expect(await host.probe("m")).toEqual({ state: "invalid", problem: "tls-https" });
  });

  it("let tls_client_auth be chosen without one", async () => {
    const host = new AiHost({ fetch, secrets: memorySecrets() });
    await host.setConnections([
      {
        id: "m",
        label: "x",
        baseUrl: "https://gw.example.com/v1",
        protocol: "openai",
        auth: {
          type: "oauth",
          flow: "client_credentials",
          clientId: "svc-1",
          clientAuth: "tls_client_auth",
        },
      },
    ]);
    expect(await host.probe("m")).toEqual({ state: "invalid", problem: "tls-client-auth" });
  });

  it("follow a redirect", async () => {
    const server = authorizationServer({ tls: pki });
    await server.start();
    servers.push(server);
    const send = mtlsFetch({ ...pki.client, ca: pki.ca });
    // /authorize answers 302; the transport must not take the certificate along.
    const url = `${server.base}/authorize?code_challenge_method=S256&redirect_uri=${encodeURIComponent("https://elsewhere.example/cb")}`;
    await expect(send(url)).rejects.toThrow(/redirect/i);
  });
});
