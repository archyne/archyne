import { Hash } from "@smithy/hash-node";
import { SignatureV4 } from "@smithy/signature-v4";

/**
 * AWS Signature Version 4 for one request, with AWS's own signer: the
 * canonical request is easy to get almost right, and almost right is a 403.
 */

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** Present for temporary credentials (STS, SSO). */
  sessionToken?: string;
}

/**
 * The headers to send with a request so that AWS accepts it: the given ones
 * plus `x-amz-date`, `Authorization` and, for temporary credentials,
 * `x-amz-security-token`.
 *
 * `Host` is signed but not returned — the transport sets it from the URL,
 * and `fetch` does not let a caller set it anyway. The path is signed as it
 * is sent, already percent-encoded; the signer encodes it once more for the
 * canonical form, as every AWS service but S3 expects.
 */
export async function signRequest(
  url: string,
  request: { method: string; headers: Record<string, string>; body?: string },
  credentials: AwsCredentials,
  scope: { region: string; service: string },
  now: Date = new Date(),
): Promise<Record<string, string>> {
  const u = new URL(url);
  const query: Record<string, string | string[]> = {};
  for (const [key, value] of u.searchParams) {
    const had = query[key];
    query[key] = had === undefined ? value : [...(Array.isArray(had) ? had : [had]), value];
  }
  const signer = new SignatureV4({
    credentials,
    region: scope.region,
    service: scope.service,
    sha256: Hash.bind(null, "sha256"),
    // The payload is in the signature already; the header copy is S3's.
    applyChecksum: false,
  });
  const signed = await signer.sign(
    {
      method: request.method,
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port ? Number(u.port) : undefined,
      path: u.pathname,
      query,
      headers: { ...request.headers, host: u.host },
      body: request.body,
    },
    { signingDate: now },
  );
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(signed.headers)) {
    if (name.toLowerCase() !== "host") headers[name] = value;
  }
  return headers;
}
