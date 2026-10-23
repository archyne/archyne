import { EventStreamCodec } from "@smithy/core/event-streams";
import { fromUtf8, toUtf8 } from "@smithy/util-utf8";
import { signRequest, type AwsCredentials } from "./sigv4";

/**
 * A stand-in AWS for tests: it checks a request's signature the way AWS
 * does — recomputed from what arrived, over the headers the request says it
 * signed — and speaks Bedrock's binary event stream back.
 */

/**
 * Whether a request, as received, carries a valid signature for these
 * credentials. Recomputing over the received method, path, signed headers
 * and body shows that nothing the signature covers changed on the way.
 */
export async function verifySigV4(
  request: {
    method: string;
    url: string;
    headers: Record<string, string | string[] | undefined>;
    body?: string;
  },
  credentials: AwsCredentials,
  scope: { region: string; service: string },
): Promise<{ ok: boolean; why?: string }> {
  const header = (name: string) => {
    const v = request.headers[name.toLowerCase()];
    return Array.isArray(v) ? v.join(",") : v;
  };
  const authorization = header("authorization");
  const date = header("x-amz-date");
  if (!authorization || !date) return { ok: false, why: "unsigned" };
  const signedNames = /SignedHeaders=([^,]+)/.exec(authorization)?.[1]?.split(";") ?? [];
  if (!signedNames.includes("host") || !signedNames.includes("x-amz-date")) {
    return { ok: false, why: `signed headers: ${signedNames.join(";")}` };
  }
  const signed: Record<string, string> = {};
  for (const name of signedNames) {
    if (name === "host") continue;
    const value = header(name);
    if (value === undefined) return { ok: false, why: `missing ${name}` };
    signed[name] = value;
  }
  const at = new Date(
    `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`,
  );
  const again = await signRequest(
    request.url,
    { method: request.method, headers: signed, body: request.body },
    credentials,
    scope,
    at,
  );
  const expected = Object.entries(again).find(
    ([k]) => k.toLowerCase() === "authorization",
  )?.[1];
  return expected === authorization
    ? { ok: true }
    : { ok: false, why: `expected ${expected}, got ${authorization}` };
}

const codec = new EventStreamCodec(toUtf8, fromUtf8);

/** One Bedrock event-stream message, as the runtime sends it. */
export function bedrockEvent(eventType: string, payload: unknown): Uint8Array {
  return codec.encode({
    headers: {
      ":event-type": { type: "string", value: eventType },
      ":content-type": { type: "string", value: "application/json" },
      ":message-type": { type: "string", value: "event" },
    },
    body: fromUtf8(JSON.stringify(payload)),
  });
}

/** An error that arrives in the stream after the 200. */
export function bedrockException(exceptionType: string, message: string): Uint8Array {
  return codec.encode({
    headers: {
      ":exception-type": { type: "string", value: exceptionType },
      ":content-type": { type: "string", value: "application/json" },
      ":message-type": { type: "string", value: "exception" },
    },
    body: fromUtf8(JSON.stringify({ message })),
  });
}
