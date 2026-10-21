/**
 * A certificate or a key loaded from a file rather than pasted. The host
 * opens the file dialog and reads the file itself, so neither the file's
 * contents nor the choice of file pass through the page — the page only
 * asks for one, and learns which fields were saved.
 *
 * What a file may hold, for which field, is checked here: a certificate
 * (PEM or DER) for the certificate and the CA, a private key (PEM, or
 * PKCS#8 DER) for the keys, a Google service account's JSON key for an
 * assertion's key, and a PKCS#12 bundle (.pfx, .p12) — the certificate and
 * its key in one file, as Windows exports them — for the certificate. A PEM
 * file holding the certificate and its key together fills both.
 */
import { createPrivateKey, X509Certificate } from "node:crypto";

/** The fields a file can be loaded into. */
export const FILE_FIELDS = new Set(["tlsCert", "tlsKey", "tlsCa", "privateKey"]);

/** What the file dialog offers for each field. */
export const FILE_EXTENSIONS: Record<string, string[]> = {
  tlsCert: ["pem", "crt", "cer", "der", "pfx", "p12"],
  tlsKey: ["pem", "key", "der"],
  tlsCa: ["pem", "crt", "cer", "der"],
  privateKey: ["pem", "key", "json", "der"],
};

/** No certificate or key comes near this; anything larger is the wrong file. */
export const MAX_FILE_BYTES = 1 << 20;

export type SecretFileResult =
  | { secrets: Array<{ field: string; value: string }> }
  | { problem: "too-large" | "empty" | "not-certificate" | "not-key" };

const BLOCK = /-----BEGIN ([A-Z0-9 ]+)-----[\s\S]+?-----END \1-----/g;

/** The PEM blocks in a text, by their label. */
function blocks(text: string): Array<{ label: string; pem: string }> {
  return [...text.matchAll(BLOCK)].map((m) => ({
    label: m[1],
    pem: m[0].replace(/\r\n/g, "\n"),
  }));
}

function isText(bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes.subarray(0, 4096)).toString("latin1");
  return head.includes("-----BEGIN") || head.trimStart().startsWith("{");
}

/** Certificates, from PEM blocks or one DER certificate; null if there are none. */
function certificates(bytes: Uint8Array): string | null {
  if (isText(bytes)) {
    const certs = blocks(Buffer.from(bytes).toString("utf8")).filter(
      (b) => b.label === "CERTIFICATE",
    );
    if (certs.length === 0) return null;
    try {
      for (const c of certs) new X509Certificate(c.pem);
    } catch {
      return null;
    }
    return `${certs.map((c) => c.pem).join("\n")}\n`;
  }
  try {
    return new X509Certificate(Buffer.from(bytes)).toString();
  } catch {
    return null;
  }
}

/** A private key, as PEM; encrypted ones are kept as they are, for the passphrase. */
function privateKey(bytes: Uint8Array): string | null {
  if (isText(bytes)) {
    const key = blocks(Buffer.from(bytes).toString("utf8")).find((b) =>
      /(^|\s)PRIVATE KEY$/.test(b.label),
    );
    return key ? `${key.pem}\n` : null;
  }
  try {
    return createPrivateKey({ key: Buffer.from(bytes), format: "der", type: "pkcs8" })
      .export({ format: "pem", type: "pkcs8" })
      .toString();
  } catch {
    return null;
  }
}

/** A Google service account's key file: JSON with a PEM `private_key`. */
function serviceAccountKey(bytes: Uint8Array): string | null {
  try {
    const parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as { private_key?: unknown };
    return typeof parsed.private_key === "string" && parsed.private_key.includes("PRIVATE KEY")
      ? Buffer.from(bytes).toString("utf8")
      : null;
  } catch {
    return null;
  }
}

/** A PKCS#12 bundle: binary, a DER SEQUENCE, and not itself a certificate. */
function pkcs12(name: string, bytes: Uint8Array): string | null {
  if (isText(bytes) || bytes[0] !== 0x30) return null;
  if (!/\.(pfx|p12)$/i.test(name)) {
    try {
      new X509Certificate(Buffer.from(bytes));
      return null;
    } catch {
      // Not a certificate; a bundle, then.
    }
  }
  return Buffer.from(bytes).toString("base64");
}

/** What a file, chosen for a field, gives to keep: one or two secrets, or why none. */
export function readSecretFile(
  field: string,
  name: string,
  bytes: Uint8Array,
): SecretFileResult {
  if (bytes.byteLength > MAX_FILE_BYTES) return { problem: "too-large" };
  if (bytes.byteLength === 0) return { problem: "empty" };
  switch (field) {
    case "tlsCert": {
      const cert = certificates(bytes);
      if (cert) {
        // A PEM file with the key beside the certificate fills both.
        const key = isText(bytes) ? privateKey(bytes) : null;
        return {
          secrets: [
            { field: "tlsCert", value: cert },
            ...(key ? [{ field: "tlsKey", value: key }] : []),
          ],
        };
      }
      const bundle = pkcs12(name, bytes);
      return bundle
        ? { secrets: [{ field: "tlsPfx", value: bundle }] }
        : { problem: "not-certificate" };
    }
    case "tlsCa": {
      const cert = certificates(bytes);
      return cert
        ? { secrets: [{ field: "tlsCa", value: cert }] }
        : { problem: "not-certificate" };
    }
    case "tlsKey": {
      const key = privateKey(bytes);
      return key ? { secrets: [{ field: "tlsKey", value: key }] } : { problem: "not-key" };
    }
    case "privateKey": {
      const key = serviceAccountKey(bytes) ?? privateKey(bytes);
      return key ? { secrets: [{ field: "privateKey", value: key }] } : { problem: "not-key" };
    }
    default:
      return { problem: "not-key" };
  }
}
