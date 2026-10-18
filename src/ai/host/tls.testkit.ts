// @peculiar/x509 registers its classes through tsyringe, which needs this
// polyfill loaded first. Test code only, like everything in this file.
import "reflect-metadata";
import * as x509 from "@peculiar/x509";

/**
 * A throwaway PKI for the mTLS tests: a CA, a server certificate for
 * 127.0.0.1, a client certificate the CA signed, and one a different CA
 * signed — the certificate a server must refuse. Generated at test time, so
 * no private key is ever committed, and valid for an hour.
 *
 * Not part of the app: nothing under src imports it outside a test.
 */
export interface Pem {
  cert: string;
  key: string;
}

export interface TestPki {
  /** The CA a server trusts for clients, and a client trusts for the server. */
  ca: string;
  server: Pem;
  client: Pem;
  /** Signed by another CA entirely. */
  stranger: Pem;
}

const ALG = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" } as const;

async function keys(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(ALG, true, ["sign", "verify"]) as Promise<CryptoKeyPair>;
}

async function pemKey(key: CryptoKey): Promise<string> {
  const der = Buffer.from(await crypto.subtle.exportKey("pkcs8", key)).toString("base64");
  const lines = der.match(/.{1,64}/g)?.join("\n") ?? der;
  return `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----\n`;
}

let serial = 1;
const window = () => ({
  notBefore: new Date(Date.now() - 60_000),
  notAfter: new Date(Date.now() + 60 * 60_000),
});

async function authority(name: string) {
  const pair = await keys();
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: String(serial++).padStart(2, "0"),
    name,
    keys: pair,
    signingAlgorithm: ALG,
    ...window(),
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
        true,
      ),
    ],
  });
  return { pair, cert };
}

async function leaf(
  ca: Awaited<ReturnType<typeof authority>>,
  subject: string,
  usage: "server" | "client",
): Promise<Pem> {
  const pair = await keys();
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: String(serial++).padStart(2, "0"),
    subject,
    issuer: ca.cert.subject,
    publicKey: pair.publicKey,
    signingKey: ca.pair.privateKey,
    signingAlgorithm: ALG,
    ...window(),
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.ExtendedKeyUsageExtension([
        usage === "server"
          ? x509.ExtendedKeyUsage.serverAuth
          : x509.ExtendedKeyUsage.clientAuth,
      ]),
      ...(usage === "server"
        ? [
            new x509.SubjectAlternativeNameExtension([
              { type: "ip", value: "127.0.0.1" },
              { type: "dns", value: "localhost" },
            ]),
          ]
        : []),
    ],
  });
  return { cert: cert.toString("pem"), key: await pemKey(pair.privateKey) };
}

export async function testPki(clientSubject = "CN=svc-1"): Promise<TestPki> {
  x509.cryptoProvider.set(crypto);
  const ca = await authority("CN=Archyne Test CA");
  const other = await authority("CN=Some Other CA");
  return {
    ca: ca.cert.toString("pem"),
    server: await leaf(ca, "CN=127.0.0.1", "server"),
    client: await leaf(ca, clientSubject, "client"),
    stranger: await leaf(other, clientSubject, "client"),
  };
}
