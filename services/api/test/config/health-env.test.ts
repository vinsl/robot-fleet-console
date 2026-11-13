/**
 * Environment of the `health` function: the version default and the refusal of a malformed value by name only.
 */
import { describe, expect, it } from "vitest";
import { loadHealthEnv } from "../../src/config/env";

const SECRET_MARKER = "SECRET-VALUE-4b1e";

describe("loadHealthEnv", () => {
  it("defaults the version to dev when the variable is absent", () => {
    expect(loadHealthEnv({})).toEqual({ APP_VERSION: "dev" });
  });

  it("reads a release label", () => {
    expect(loadHealthEnv({ APP_VERSION: "1.2.3+build.7" })).toEqual({
      APP_VERSION: "1.2.3+build.7",
    });
  });

  it("refuses an empty or malformed version, naming the variable and not its value", () => {
    for (const value of ["", `bad value ${SECRET_MARKER}`, "x".repeat(65)]) {
      expect(() => loadHealthEnv({ APP_VERSION: value })).toThrow(
        "invalid environment: APP_VERSION",
      );
      expect(() => loadHealthEnv({ APP_VERSION: value })).not.toThrow(SECRET_MARKER);
    }
  });
});
