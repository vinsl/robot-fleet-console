/**
 * The `health` handler over fixed ports: the report it returns, its headers, and the failure it refuses to leak.
 */
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { describe, expect, it } from "vitest";
import { createHealthHandler } from "../../src/handlers/health";
import { FixedClock } from "../fakes/fixed";
import { RecordingHandlerLogger } from "../fakes/recording";

const NOW = new Date("2026-11-02T10:00:00.000Z");

/**
 * A proxy event with a request id and nothing else; the health route reads no header and no body.
 *
 * @returns The event.
 */
function event(): APIGatewayProxyEventV2 {
  return { requestContext: { requestId: "req-health-0001" } } as unknown as APIGatewayProxyEventV2;
}

describe("GET /health handler", () => {
  it("returns exactly status, version and the millisecond timestamp, with no caching", () => {
    const handler = createHealthHandler({
      version: "1.2.3",
      clock: new FixedClock(NOW),
      logger: new RecordingHandlerLogger(),
    });
    const response = handler(event());
    expect(response.statusCode).toBe(200);
    expect(response.headers).toMatchObject({ "cache-control": "no-store" });
    expect(JSON.parse(response.body ?? "")).toEqual({
      status: "ok",
      version: "1.2.3",
      time: "2026-11-02T10:00:00.000Z",
    });
  });

  it("answers 500 with no internal text when the clock yields an invalid instant", () => {
    const logger = new RecordingHandlerLogger();
    const handler = createHealthHandler({
      version: "dev",
      clock: { now: () => new Date("not a date") },
      logger,
    });
    const response = handler(event());
    expect(response.statusCode).toBe(500);
    expect(response.body).toContain("urn:mfc:problem:internal");
    expect(response.body).not.toMatch(/RangeError|Invalid time value/);
    expect(logger.entries.map((entry) => entry.message)).toContain("health report failed");
  });
});
