// @vitest-environment node
// Node, not jsdom: node:crypto, node:https and openssl's output need Node's realm.
import { execFileSync } from "node:child_process";
import { createPrivateKey, generateKeyPairSync, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { authorizationServer } from "./authServer.testkit";
import { AiHost, secretKey, type PickedFile, type SecretStore } from "./core";
import { readSecretFile, MAX_FILE_BYTES } from "./secretFile";
import { testPki, type TestPki } from "./tls.testkit";

/**
 * Certificates and keys loaded from a file, in the host's own dialog: what a
 * file may hold for each field, and what the host keeps of it. The PKCS#12
 * bundle is made by openssl from the test PKI, the way a certificate is
 * exported on Windows; Node reads one but cannot write one.
 */

let pki: TestPki;
beforeAll(async () => {
  pki = await testPki("CN=svc-1");
});

const text = (s: string) => new TextEncoder().encode(s);

/** The test client's certificate and key as a .pfx, or null where there is no openssl. */
function pfx(password: string): Uint8Array | null {
  const dir = mkdtempSync(join(tmpdir(), "archyne-pfx-"));
  try {
    writeFileSync(join(dir, "cert.pem"), pki.client.cert);
    writeFileSync(join(dir, "key.pem"), pki.client.key);
    execFileSync(
      "openssl",
      [
        "pkcs12",
        "-export",
        "-inkey",
        join(dir, "key.pem"),
        "-in",
        join(dir, "cert.pem"),
        "-out",
        join(dir, "client.pfx"),
        "-passout",
        `pass:${password}`,
      ],
      { stdio: "ignore" },
    );
    return readFileSync(join(dir, "client.pfx"));
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("what a file may hold", () => {
  it("takes a PEM certificate, and a DER one as PEM", () => {
    const pem = readSecretFile("tlsCert", "client.pem", text(pki.client.cert));
    expect(pem).toEqual({
      secrets: [{ field: "tlsCert", value: expect.stringContaining("BEGIN CERTIFICATE") }],
    });
    const der = new X509Certificate(pki.client.cert).raw;
    const fromDer = readSecretFile("tlsCert", "client.cer", der);
    expect(fromDer).toMatchObject({ secrets: [{ field: "tlsCert" }] });
    const value = (fromDer as { secrets: Array<{ value: string }> }).secrets[0].value;
    expect(new X509Certificate(value).fingerprint256).toBe(
      new X509Certificate(pki.client.cert).fingerprint256,
    );
  });

  it("fills the certificate and its key from one PEM that holds both", () => {
    const both = readSecretFile(
      "tlsCert",
      "client.pem",
      text(`${pki.client.cert}\n${pki.client.key}`),
    );
    expect(both).toMatchObject({
      secrets: [
        { field: "tlsCert", value: expect.not.stringContaining("PRIVATE KEY") },
        { field: "tlsKey", value: expect.stringContaining("PRIVATE KEY") },
      ],
    });
  });

  it("keeps a whole CA bundle", () => {
    const bundle = readSecretFile("tlsCa", "ca.pem", text(`${pki.ca}\n${pki.client.cert}`));
    const value = (bundle as { secrets: Array<{ value: string }> }).secrets[0].value;
    expect(value.match(/BEGIN CERTIFICATE/g)).toHaveLength(2);
  });

  it("takes a key as PEM, encrypted or not, or as PKCS#8 DER", () => {
    expect(readSecretFile("tlsKey", "k.pem", text(pki.client.key))).toMatchObject({
      secrets: [{ field: "tlsKey" }],
    });
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const encrypted = privateKey.export({
      type: "pkcs8",
      format: "pem",
      cipher: "aes-256-cbc",
      passphrase: "p",
    });
    expect(readSecretFile("tlsKey", "k.pem", text(String(encrypted)))).toMatchObject({
      secrets: [{ value: expect.stringContaining("ENCRYPTED PRIVATE KEY") }],
    });
    const der = createPrivateKey(pki.client.key).export({ type: "pkcs8", format: "der" });
    expect(readSecretFile("tlsKey", "k.der", der)).toMatchObject({
      secrets: [{ value: expect.stringContaining("BEGIN PRIVATE KEY") }],
    });
  });

  it("takes a Google service account's key file for an assertion", () => {
    const json = JSON.stringify({
      type: "service_account",
      client_email: "a@b.iam.gserviceaccount.com",
      private_key: pki.client.key,
    });
    expect(readSecretFile("privateKey", "sa.json", text(json))).toEqual({
      secrets: [{ field: "privateKey", value: json }],
    });
  });

  it("refuses what is not one: a key for a certificate, a certificate for a key, anything else", () => {
    expect(readSecretFile("tlsCert", "k.pem", text(pki.client.key))).toEqual({
      problem: "not-certificate",
    });
    expect(readSecretFile("tlsKey", "c.pem", text(pki.client.cert))).toEqual({
      problem: "not-key",
    });
    expect(readSecretFile("tlsCa", "notes.txt", text("hello"))).toEqual({
      problem: "not-certificate",
    });
    expect(readSecretFile("privateKey", "x.json", text('{"private_key": 3}'))).toEqual({
      problem: "not-key",
    });
    expect(readSecretFile("tlsKey", "k.pem", new Uint8Array())).toEqual({ problem: "empty" });
    expect(readSecretFile("tlsCert", "big.pem", new Uint8Array(MAX_FILE_BYTES + 1))).toEqual({
      problem: "too-large",
    });
  });

  it("keeps a .pfx bundle as it is, for the certificate and its key", ({ skip }) => {
    const bundle = pfx("bundle-pass");
    if (!bundle) return skip();
    expect(readSecretFile("tlsCert", "client.pfx", bundle)).toEqual({
      secrets: [{ field: "tlsPfx", value: Buffer.from(bundle).toString("base64") }],
    });
  });
});

describe("loading one through the host", () => {
  let servers: Array<{ close(): void }> = [];
  afterEach(() => {
    servers.forEach((s) => s.close());
    servers = [];
  });

  function memorySecrets(): SecretStore & { data: Map<string, string> } {
    const data = new Map<string, string>();
    return {
      data,
      get: async (k) => data.get(k),
      set: async (k, v) => void data.set(k, v),
      delete: async (k) => void data.delete(k),
    };
  }

  const file = (name: string, bytes: Uint8Array): PickedFile => ({
    name,
    size: bytes.byteLength,
    read: async () => bytes,
  });

  async function host(picks: Array<PickedFile | null>) {
    const server = authorizationServer({ tls: pki, serviceAuth: "certificate" });
    await server.start();
    servers.push(server);
    const secrets = memorySecrets();
    const titles: string[] = [];
    const h = new AiHost({
      fetch,
      secrets,
      pickFile: async ({ title }) => {
        titles.push(title);
        return picks.shift() ?? null;
      },
    });
    await h.setConnections(
      [
        {
          id: "m",
          label: "Gateway behind mTLS",
          baseUrl: `${server.base}/v1`,
          protocol: "openai",
          auth: { type: "none" },
          clientCertificate: true,
        },
      ],
      "it",
    );
    await h.setSecret("m", "tlsCa", pki.ca);
    return { h, secrets, titles };
  }

  it("asks in the app's language, keeps what the file holds, and tells only which fields", async () => {
    const { h, secrets, titles } = await host([
      file("client.pem", text(`${pki.client.cert}\n${pki.client.key}`)),
    ]);
    expect(await h.importSecretFile("m", "tlsCert")).toEqual({ saved: ["tlsCert", "tlsKey"] });
    expect(titles).toEqual(["Archyne — certificato client"]);
    expect(secrets.data.get(secretKey("m", "tlsKey"))).toContain("PRIVATE KEY");
    expect(await h.probe("m")).toMatchObject({ state: "ok", models: ["secured-model"] });
  });

  it("opens the service with a .pfx and its passphrase, in place of the PEM pair", async ({
    skip,
  }) => {
    const bundle = pfx("bundle-pass");
    if (!bundle) return skip();
    const { h, secrets } = await host([
      file("client.pem", text(`${pki.client.cert}\n${pki.client.key}`)),
      file("client.pfx", bundle),
    ]);
    await h.importSecretFile("m", "tlsCert");
    expect(await h.importSecretFile("m", "tlsCert")).toEqual({ saved: ["tlsPfx"] });
    expect(secrets.data.has(secretKey("m", "tlsCert"))).toBe(false);
    expect(secrets.data.has(secretKey("m", "tlsKey"))).toBe(false);
    await h.setSecret("m", "tlsPassphrase", "bundle-pass");
    expect(await h.secretFields("m")).toContain("tlsPfx");
    expect(await h.probe("m")).toMatchObject({ state: "ok", models: ["secured-model"] });
  });

  it("says why a file will not do, and keeps nothing of it", async () => {
    const { h, secrets } = await host([file("notes.txt", text("hello")), null]);
    expect(await h.importSecretFile("m", "tlsKey")).toEqual({ problem: "not-key" });
    expect(await h.importSecretFile("m", "tlsKey")).toEqual({ cancelled: true });
    expect(secrets.data.has(secretKey("m", "tlsKey"))).toBe(false);
    expect(await h.importSecretFile("m", "key")).toEqual({ problem: "invalid" });
  });

  it("will not open a dialog for a host that has none", async () => {
    const h = new AiHost({ fetch, secrets: memorySecrets() });
    await h.setConnections([
      {
        id: "m",
        label: "x",
        baseUrl: "https://x.example/v1",
        protocol: "openai",
        auth: { type: "none" },
      },
    ]);
    expect(await h.importSecretFile("m", "tlsCert")).toEqual({ problem: "unsupported" });
  });
});
