/**
 * The `control` handler: the outcomes of the allowed requests, the refusals, and the failures that must not leak. The
 * denied-access rows of every route live in `test/denied-access.test.ts`.
 */
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { describe, expect, it, vi } from "vitest";
import {
  CommandResponseSchema,
  DemoStateSchema,
  LockActionResponseSchema,
  LockStateSchema,
  RobotListResponseSchema,
  type LockToken,
} from "@mfc/protocol";
import { createControlHandler, type ControlHandlerDeps } from "../../src/handlers/control";
import { RecordingHandlerLogger } from "../fakes/recording";
import {
  CONTROL_ROBOT,
  CONTROL_SITE,
  OPERATOR_SUB,
  commandIdOf,
  controlWorld,
  liveLockOf,
  type ControlWorld,
} from "../fakes/control";

// The module builds its production handler at import, so its environment must exist first.
vi.hoisted(() => {
  vi.stubEnv("AWS_REGION", "eu-west-3");
  vi.stubEnv("FLEET_TABLE_NAME", "mfc-demo-fleet");
  vi.stubEnv("EVENTS_TABLE_NAME", "mfc-demo-events");
  vi.stubEnv("CONNECTIONS_TABLE_NAME", "mfc-demo-connections");
  vi.stubEnv(
    "WS_MANAGEMENT_ENDPOINT",
    "https://abc123xyz.execute-api.eu-west-3.amazonaws.com/live",
  );
  vi.stubEnv("IOT_DATA_ENDPOINT", "abc123-ats.iot.eu-west-3.amazonaws.com");
});

/** Claims of an Operator access token of the demo site. */
const OPERATOR_CLAIMS = {
  sub: OPERATOR_SUB,
  token_use: "access",
  client_id: "clientapp01",
  "cognito:groups": "[Operator]",
};

/** Route keys and path parameters of the control API, for the demo site and the fixture robot. */
const ROUTE = {
  list: { routeKey: "GET /sites/{siteId}/robots", pathParameters: { siteId: CONTROL_SITE } },
  getLock: {
    routeKey: "GET /sites/{siteId}/robots/{robotId}/lock",
    pathParameters: { siteId: CONTROL_SITE, robotId: CONTROL_ROBOT },
  },
  acquire: {
    routeKey: "POST /sites/{siteId}/robots/{robotId}/lock",
    pathParameters: { siteId: CONTROL_SITE, robotId: CONTROL_ROBOT },
  },
  release: {
    routeKey: "POST /sites/{siteId}/robots/{robotId}/lock/release",
    pathParameters: { siteId: CONTROL_SITE, robotId: CONTROL_ROBOT },
  },
  command: {
    routeKey: "POST /sites/{siteId}/robots/{robotId}/commands",
    pathParameters: { siteId: CONTROL_SITE, robotId: CONTROL_ROBOT },
  },
  getDemo: { routeKey: "GET /sites/{siteId}/demo", pathParameters: { siteId: CONTROL_SITE } },
  setDemo: { routeKey: "PUT /sites/{siteId}/demo", pathParameters: { siteId: CONTROL_SITE } },
} as const;

/** A harness: the handler over a fresh world, with its logger and metrics kept for assertions. */
interface Harness {
  readonly handler: ReturnType<typeof createControlHandler>;
  readonly world: ControlWorld;
  readonly logger: RecordingHandlerLogger;
  readonly publishStoredMetrics: ReturnType<typeof vi.fn<() => void>>;
}

/**
 * Builds the handler over a fresh control world.
 *
 * @returns The harness.
 */
function harness(): Harness {
  const world = controlWorld();
  const logger = new RecordingHandlerLogger();
  const publishStoredMetrics = vi.fn<() => void>();
  const deps: ControlHandlerDeps = {
    logger,
    metrics: {
      count: (name) => {
        world.metrics.count(name);
      },
      publishStoredMetrics,
    },
    tracer: { putAnnotation: vi.fn() },
    ports: {
      locks: world.deps.locks,
      claims: world.deps.claims,
      demo: world.deps.demo,
      robots: world.deps.robots,
      publisher: world.deps.publisher,
      relay: world.deps.relay,
      audit: world.deps.audit,
      clock: world.deps.clock,
      ids: world.deps.ids,
      randomBytes: world.deps.randomBytes,
    },
  };
  return { handler: createControlHandler(deps), world, logger, publishStoredMetrics };
}

/**
 * Builds a proxy event.
 *
 * @param route - The route key and path parameters.
 * @param body - The raw body, when the request has one.
 * @param claims - Claims of the access token, merged over the Operator defaults.
 * @returns The event.
 */
function eventOf(
  route: { readonly routeKey: string; readonly pathParameters: Readonly<Record<string, string>> },
  body?: string,
  claims: Record<string, unknown> = {},
): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    routeKey: route.routeKey,
    pathParameters: route.pathParameters,
    body,
    requestContext: {
      requestId: "req-0100-abcdef",
      authorizer: { jwt: { claims: { ...OPERATOR_CLAIMS, ...claims } } },
    },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

/**
 * Parses the JSON body of a response.
 *
 * @param body - The body text.
 * @returns The parsed value, unchecked.
 */
function jsonOf(body: string | undefined): unknown {
  return JSON.parse(body ?? "null");
}

describe("control handler: outcomes", () => {
  it("answers a command with the protocol response and no-store", async () => {
    const { handler, world } = harness();
    world.locks.put(liveLockOf(OPERATOR_SUB));
    const response = await handler(
      eventOf(ROUTE.command, JSON.stringify({ commandId: commandIdOf(1), type: "PAUSE" })),
    );

    expect(response.statusCode).toBe(200);
    expect(response.headers?.["cache-control"]).toBe("no-store");
    expect(CommandResponseSchema.parse(jsonOf(response.body))).toMatchObject({
      commandId: commandIdOf(1),
      deduplicated: false,
    });
  });

  it("answers a replayed command with deduplicated true and publishes once", async () => {
    const { handler, world } = harness();
    world.locks.put(liveLockOf(OPERATOR_SUB));
    const body = JSON.stringify({ commandId: commandIdOf(2), type: "PAUSE" });
    await handler(eventOf(ROUTE.command, body));
    const replay = await handler(eventOf(ROUTE.command, body));

    expect(CommandResponseSchema.parse(jsonOf(replay.body))).toMatchObject({ deduplicated: true });
    expect(world.publisher.published).toHaveLength(1);
  });

  it("answers a lock take and a release with the lock action response", async () => {
    const { handler, world } = harness();
    const taken = await handler(
      eventOf(ROUTE.acquire, JSON.stringify({ commandId: commandIdOf(3) })),
    );
    expect(LockActionResponseSchema.parse(jsonOf(taken.body))).toMatchObject({
      changed: true,
      lock: { mine: true },
    });

    const released = await handler(
      eventOf(ROUTE.release, JSON.stringify({ commandId: commandIdOf(4) })),
    );
    expect(LockActionResponseSchema.parse(jsonOf(released.body))).toMatchObject({
      changed: true,
      lock: { held: false },
    });
    expect(world.locks.items.has(CONTROL_ROBOT)).toBe(false);
  });

  it("answers the lock state of a robot without its token", async () => {
    const { handler, world } = harness();
    world.locks.put(liveLockOf(OPERATOR_SUB));
    const response = await handler(eventOf(ROUTE.getLock));

    expect(LockStateSchema.parse(jsonOf(response.body))).toMatchObject({ held: true, mine: true });
  });

  it("answers the robot list with summaries", async () => {
    const { handler } = harness();
    const response = await handler(eventOf(ROUTE.list));

    expect(RobotListResponseSchema.parse(jsonOf(response.body)).robots.length).toBeGreaterThan(0);
  });

  it("answers the demo state for every role and switches it for an Admin", async () => {
    const { handler } = harness();
    const read = await handler(eventOf(ROUTE.getDemo));
    expect(DemoStateSchema.parse(jsonOf(read.body))).toEqual({ enabled: false });

    const write = await handler(
      eventOf(ROUTE.setDemo, JSON.stringify({ enabled: true }), { "cognito:groups": "[Admin]" }),
    );
    expect(write.statusCode).toBe(200);
    expect(DemoStateSchema.parse(jsonOf(write.body))).toMatchObject({
      enabled: true,
      changedBy: OPERATOR_SUB,
    });
  });

  it("answers a command without the lock with the lock-not-held problem", async () => {
    const { handler, world } = harness();
    const response = await handler(
      eventOf(ROUTE.command, JSON.stringify({ commandId: commandIdOf(5), type: "PAUSE" })),
    );

    expect(response.statusCode).toBe(409);
    expect(response.headers?.["content-type"]).toBe("application/problem+json");
    expect(jsonOf(response.body)).toMatchObject({
      type: "urn:mfc:problem:lock-not-held",
      status: 409,
    });
    expect(world.publisher.published).toEqual([]);
  });

  it("refuses a body with a parameter the command does not take", async () => {
    const { handler, world } = harness();
    world.locks.put(liveLockOf(OPERATOR_SUB));
    const response = await handler(
      eventOf(
        ROUTE.command,
        JSON.stringify({ commandId: commandIdOf(6), type: "PAUSE", params: { x: 1 } }),
      ),
    );

    expect(response.statusCode).toBe(400);
    expect(world.publisher.published).toEqual([]);
  });

  it("answers an unexpected failure as a 500 with no internal text", async () => {
    const { handler, world } = harness();
    world.robots.get = () =>
      Promise.reject(new Error("secret table arn arn:aws:dynamodb:eu-west-3:123456789012:table/x"));
    const response = await handler(
      eventOf(ROUTE.command, JSON.stringify({ commandId: commandIdOf(7), type: "PAUSE" })),
    );

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("arn:aws");
    expect(response.body).not.toContain("secret");
  });

  it("publishes its counters once per invocation and leaves no invocation key behind", async () => {
    const { handler, publishStoredMetrics, logger } = harness();
    await handler(eventOf(ROUTE.list));

    expect(publishStoredMetrics).toHaveBeenCalledTimes(1);
    expect(logger.keys.size).toBe(0);
  });
});

describe("control handler: the lock token never leaves the cloud", () => {
  it("lock-response-has-no-token", async () => {
    const { handler, world, logger } = harness();
    const taken = await handler(
      eventOf(ROUTE.acquire, JSON.stringify({ commandId: commandIdOf(8) })),
    );
    // Read right after the take: the release below deletes the item, and the token must be checked while it exists.
    const token: LockToken | undefined = world.locks.items.get(CONTROL_ROBOT)?.token;
    const state = await handler(eventOf(ROUTE.getLock));
    const command = await handler(
      eventOf(ROUTE.command, JSON.stringify({ commandId: commandIdOf(9), type: "PAUSE" })),
    );
    const released = await handler(
      eventOf(ROUTE.release, JSON.stringify({ commandId: commandIdOf(10) })),
    );
    const everything = JSON.stringify([
      taken,
      state,
      command,
      released,
      logger.entries,
      world.audit.records,
      world.relay.changes,
    ]);

    expect(token).toBeDefined();
    expect(everything).not.toContain(String(token));
  });
});
