import { describe, expect, it } from "vitest";
import { getProvider, resolveAiMode } from "./provider";

describe("resolveAiMode", () => {
  it("runs the stub in development, so the pipeline is exercised for real", () => {
    expect(resolveAiMode({ dev: true })).toBe("stub");
  });

  it("respects an explicit stub even in a production build (CI)", () => {
    expect(resolveAiMode({ dev: false, explicit: "stub" })).toBe("stub");
  });

  it("turns AI off in a production build with no flag", () => {
    expect(resolveAiMode({ dev: false })).toBe("off");
  });

  it("runs the real engine only when the person chooses it", () => {
    expect(resolveAiMode({ dev: true, explicit: "local" })).toBe("local");
    expect(resolveAiMode({ dev: false, explicit: "local" })).toBe("local");
  });

  it("keeps the historical flag for the real engine", () => {
    expect(resolveAiMode({ dev: false, explicit: "transformers" })).toBe("local");
  });

  it("prefers an explicit flag over the dev default", () => {
    expect(resolveAiMode({ dev: true, explicit: "stub" })).toBe("stub");
    expect(resolveAiMode({ dev: true, explicit: "local" })).toBe("local");
  });
});

describe("getProvider", () => {
  it("hands out the stub provider to a dev build", () => {
    // vitest runs with DEV=true.
    expect(getProvider()?.kind).toBe("fake");
    expect(getProvider()?.available()).toBe(true);
  });
});
