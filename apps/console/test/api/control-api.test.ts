/**
 * Control API: route builders refuse identifiers that are not protocol identifiers, and an answer that does not
 * match its schema is refused before the UI sees it.
 */
import { describe, expect, it } from "vitest";
import { uuidv7 } from "@mfc/protocol";
import { controlPaths, postCommand } from "../../src/api/control";
import { ApiError } from "../../src/api/http-client";
import { createControlHarness, json, ROBOT, SITE } from "../control/support";

describe("control routes", () => {
  it("builds every route under the site from validated identifiers", () => {
    expect(controlPaths.robots(SITE)).toBe("/sites/paris-01/robots");
    expect(controlPaths.lock(SITE, ROBOT)).toBe("/sites/paris-01/robots/sim-01/lock");
    expect(controlPaths.lockRelease(SITE, ROBOT)).toBe(
      "/sites/paris-01/robots/sim-01/lock/release",
    );
    expect(controlPaths.commands(SITE, ROBOT)).toBe("/sites/paris-01/robots/sim-01/commands");
    expect(controlPaths.demo(SITE)).toBe("/sites/paris-01/demo");
  });

  it("refuses a robot identifier that would add a path segment", () => {
    expect(() => controlPaths.lock(SITE, "../admin")).toThrow(TypeError);
    expect(() => controlPaths.commands(SITE, "sim-01/../../x")).toThrow(TypeError);
  });
});

describe("control requests", () => {
  it("refuses an answer that does not match the command schema", async () => {
    const harness = createControlHarness(() => json(200, { unexpected: true }));

    const outcome = await postCommand(harness.services.api, ROBOT, {
      commandId: uuidv7(),
      type: "PAUSE",
    }).catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(ApiError);
    expect(outcome).toMatchObject({ kind: "invalid-response" });
  });
});
