import { describe, expect, it } from "vitest";
import { initialEngine } from "./engine";

describe("the engine a page starts with", () => {
  it("is the build's own engine unless the local server was chosen", () => {
    expect(initialEngine({}, true)).toBe("browser");
    expect(initialEngine({ engine: "server" }, true)).toBe("server");
    expect(initialEngine({ engine: "browser" }, true)).toBe("browser");
  });

  it("is the local server in a build that carries no engine, whatever was stored", () => {
    // A release build: the stored choice may come from a dev or local build
    // on the same origin, and "browser" would point at nothing.
    expect(initialEngine({}, false)).toBe("server");
    expect(initialEngine({ engine: "browser" }, false)).toBe("server");
  });

  it("treats a stored value it does not know as the default", () => {
    expect(initialEngine({ engine: "cloud" as never }, true)).toBe("browser");
  });
});
