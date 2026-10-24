// @vitest-environment node
import { describe, expect, it } from "vitest";
import { signRequest } from "./sigv4";
import { verifySigV4 } from "./sigv4.testkit";

/**
 * The signature against AWS's published test suite (aws-sig-v4-test-suite),
 * so the wrapper around the signer — the URL taken apart, the query, the
 * host — is checked against answers nobody here computed.
 */

const EXAMPLE = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};
const SCOPE = { region: "us-east-1", service: "service" };
const AT = new Date("2015-08-30T12:36:00Z");

describe("signRequest", () => {
  it("matches get-vanilla", async () => {
    const h = await signRequest(
      "https://example.amazonaws.com/",
      { method: "GET", headers: {} },
      EXAMPLE,
      SCOPE,
      AT,
    );
    expect(h["x-amz-date"]).toBe("20150830T123600Z");
    expect(h.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, " +
        "SignedHeaders=host;x-amz-date, " +
        "Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
    expect(Object.keys(h).map((k) => k.toLowerCase())).not.toContain("host");
  });

  it("matches get-vanilla-query-order-key-case: the query sorted, not as written", async () => {
    const h = await signRequest(
      "https://example.amazonaws.com/?Param2=value2&Param1=value1",
      { method: "GET", headers: {} },
      EXAMPLE,
      SCOPE,
      AT,
    );
    expect(h.authorization).toContain(
      "Signature=b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500",
    );
  });

  it("adds the session token of temporary credentials, and signs it", async () => {
    const h = await signRequest(
      "https://bedrock-runtime.eu-west-1.amazonaws.com/model/m/converse-stream",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      { ...EXAMPLE, sessionToken: "FQoGZXIvYXdzEXAMPLE" },
      { region: "eu-west-1", service: "bedrock" },
      AT,
    );
    expect(h["x-amz-security-token"]).toBe("FQoGZXIvYXdzEXAMPLE");
    expect(h.authorization).toMatch(/SignedHeaders=[^,]*x-amz-security-token/);
  });

  it("is refused by the stand-in when the body changes after signing", async () => {
    const url = "https://bedrock-runtime.us-east-1.amazonaws.com/model/a%3A0/converse-stream";
    const scope = { region: "us-east-1", service: "bedrock" };
    const headers = await signRequest(
      url,
      { method: "POST", headers: { "content-type": "application/json" }, body: '{"a":1}' },
      EXAMPLE,
      scope,
    );
    const lower = Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
    );
    const asSent = { method: "POST", url, headers: lower };
    expect(await verifySigV4({ ...asSent, body: '{"a":1}' }, EXAMPLE, scope)).toEqual({
      ok: true,
    });
    expect((await verifySigV4({ ...asSent, body: '{"a":2}' }, EXAMPLE, scope)).ok).toBe(false);
    expect(
      (
        await verifySigV4(
          { ...asSent, body: '{"a":1}' },
          { ...EXAMPLE, secretAccessKey: "x" },
          scope,
        )
      ).ok,
    ).toBe(false);
  });
});
