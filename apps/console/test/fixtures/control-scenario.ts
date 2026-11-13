/**
 * Fixtures of the control scenario: the control routes of one simulated robot, the frames that answer the commands
 * and the locks, and the two users who drive the robot panel.
 *
 * The control backend answers the control routes as the cloud would: it keeps the lock, refuses a take while another
 * subject holds it, and checks each request body against the protocol schemas. Every other route (health, realtime
 * token, map, alerts) is answered by the fleet backend, which the scenario reuses unchanged. Nothing reaches the
 * network, and the socket is the fake of the fleet fixtures, so a frame the wire would refuse fails here too.
 */
import {
  AckSchema,
  CommandRequestSchema,
  CommandResponseSchema,
  DEMO_SITE_ID,
  DemoStateSchema,
  LockActionResponseSchema,
  LockRequestSchema,
  LockStateSchema,
  RobotIdSchema,
  RobotListResponseSchema,
  WsServerMessageSchema,
  uuidv7,
  type AckReason,
  type LockState,
  type RobotId,
  type WsServerMessage,
} from "@mfc/protocol";
import { vi, type Mock } from "vitest";
import type { Session } from "../../src/auth/cognito-client";
import { deltaOf, sampleOf } from "../live/support";
import { jsonResponse } from "../site/backend";
import { TEST_CONFIG } from "../support/console-harness";
import {
  SCENARIO_NOW,
  SCENARIO_NOW_MS,
  SESSION_MS,
  createScenarioBackend,
  type FakeSocket,
  type ScenarioRequest,
} from "./fleet-scenario";

/** Correlation identifier the control answers carry. Only its shape matters to the console. */
const CORRELATION_ID = "corr-0001-abcd";

/** The robot the scenario opens. It is the first robot of the fleet snapshot. */
export const SCENARIO_ROBOT: RobotId = RobotIdSchema.parse("sim-01");

/** Subject of the Operator who drives the robot. A UUID, as the cloud issues it. */
export const OPERATOR_SUB = "11111111-2222-3333-4444-555555555555";

/** Subject of a second Operator, who holds the lock in some scenarios. Its last four characters name it on screen. */
export const OTHER_OPERATOR_SUB = "99999999-8888-7777-6666-555555555555";

/** Subject of the Viewer, who reads the robot but never commands it. */
export const VIEWER_SUB = "22222222-3333-4444-5555-666666666666";

/** An Operator, who may take the lock, command the robot and stop it. */
export const CONTROL_OPERATOR: Session = {
  userId: OPERATOR_SUB,
  groups: ["Operator"],
  expiresAtMs: SCENARIO_NOW_MS + SESSION_MS,
};

/** A Viewer, who sees the lock and no command. */
export const CONTROL_VIEWER: Session = {
  userId: VIEWER_SUB,
  groups: ["Viewer"],
  expiresAtMs: SCENARIO_NOW_MS + SESSION_MS,
};

/** Path of the registry of the demo site. */
const ROBOTS_PATH = `/sites/${DEMO_SITE_ID}/robots`;

/** Path of the demo mode of the demo site. */
const DEMO_PATH = `/sites/${DEMO_SITE_ID}/demo`;

/** Path of the lock of the scenario robot. */
export const LOCK_PATH = `${ROBOTS_PATH}/${SCENARIO_ROBOT}/lock`;

/** Path of the lock release of the scenario robot. */
export const RELEASE_PATH = `${LOCK_PATH}/release`;

/** Path of the commands of the scenario robot. */
export const COMMANDS_PATH = `${ROBOTS_PATH}/${SCENARIO_ROBOT}/commands`;

/** The scripted control backend of the scenario. */
export interface ControlScenarioBackend {
  /** Fetch stub, installed with `vi.stubGlobal`. Control routes are answered here, the others by the fleet backend. */
  readonly fetch: Mock<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>;
  /** API requests received so far, in order, control routes included. */
  readonly requests: readonly ScenarioRequest[];
  /** Sockets the client opened, in order. */
  readonly sockets: readonly FakeSocket[];
  /** Socket factory for the services. */
  readonly createSocket: (url: string) => FakeSocket;
}

/**
 * A problem document with a status, as the API answers a refused request.
 *
 * @param status - HTTP status.
 * @returns The response.
 */
function problemResponse(status: number): Response {
  return new Response(JSON.stringify({ title: "request refused", status }), {
    status,
    headers: { "content-type": "application/problem+json" },
  });
}

/**
 * Parses a request body, or returns `undefined` for an empty or malformed body. The caller validates the result.
 *
 * @param body - Raw request body.
 * @returns The parsed value, or `undefined`.
 */
function parseBody(body: string | undefined): unknown {
  if (body === undefined) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * The lock state the cloud reports for the scenario robot, as seen by `caller`.
 *
 * @param holder - Subject that holds the lock, or `undefined` when it is free.
 * @param caller - Subject of the signed-in user the answer is for.
 * @returns The validated lock state.
 */
function lockStateOf(holder: string | undefined, caller: string): LockState {
  return LockStateSchema.parse(
    holder === undefined
      ? { robotId: SCENARIO_ROBOT, held: false, mine: false }
      : { robotId: SCENARIO_ROBOT, held: true, holder, mine: holder === caller },
  );
}

/**
 * Creates the scripted control backend for one signed-in user. The lock is kept here, as the cloud keeps it, so
 * a take changes what the next read returns.
 *
 * @param caller - Subject of the signed-in user.
 * @returns The backend.
 */
export function createControlScenarioBackend(caller: string): ControlScenarioBackend {
  const fleet = createScenarioBackend();
  const requests: ScenarioRequest[] = [];
  const cloud: { holder: string | undefined } = { holder: undefined };

  /**
   * Answers one control request, or returns `undefined` when the request is not a control route.
   *
   * @param method - HTTP method, in upper case.
   * @param path - Path of the request.
   * @param body - Raw request body.
   * @returns The response, or `undefined` for a route of the fleet backend.
   */
  function answerControl(
    method: string,
    path: string,
    body: string | undefined,
  ): Response | undefined {
    if (method === "GET" && path === ROBOTS_PATH) {
      return jsonResponse(
        200,
        RobotListResponseSchema.parse({
          robots: [
            {
              robotId: SCENARIO_ROBOT,
              siteId: DEMO_SITE_ID,
              name: "Robot 01",
              type: "AMR-200",
              designDate: "2026-10-01",
              simulated: true,
              status: "ACTIVE",
              createdAt: "2026-10-01T08:00:00.000Z",
            },
          ],
        }),
      );
    }
    if (method === "GET" && path === DEMO_PATH) {
      return jsonResponse(200, DemoStateSchema.parse({ enabled: false }));
    }
    if (method === "GET" && path === LOCK_PATH) {
      return jsonResponse(200, lockStateOf(cloud.holder, caller));
    }
    if (method === "POST" && path === LOCK_PATH) {
      const parsed = LockRequestSchema.safeParse(parseBody(body));
      if (!parsed.success) {
        return problemResponse(400);
      }
      if (cloud.holder !== undefined && cloud.holder !== caller) {
        return problemResponse(409);
      }
      const changed = cloud.holder !== caller;
      cloud.holder = caller;
      return jsonResponse(
        200,
        LockActionResponseSchema.parse({
          commandId: parsed.data.commandId,
          correlationId: CORRELATION_ID,
          changed,
          lock: lockStateOf(caller, caller),
        }),
      );
    }
    if (method === "POST" && path === RELEASE_PATH) {
      const parsed = LockRequestSchema.safeParse(parseBody(body));
      if (!parsed.success) {
        return problemResponse(400);
      }
      if (cloud.holder !== undefined && cloud.holder !== caller) {
        return problemResponse(409);
      }
      const changed = cloud.holder !== undefined;
      cloud.holder = undefined;
      return jsonResponse(
        200,
        LockActionResponseSchema.parse({
          commandId: parsed.data.commandId,
          correlationId: CORRELATION_ID,
          changed,
          lock: lockStateOf(undefined, caller),
        }),
      );
    }
    if (method === "POST" && path === COMMANDS_PATH) {
      const parsed = CommandRequestSchema.safeParse(parseBody(body));
      if (!parsed.success) {
        return problemResponse(400);
      }
      return jsonResponse(
        200,
        CommandResponseSchema.parse({
          commandId: parsed.data.commandId,
          correlationId: CORRELATION_ID,
          issuedAt: SCENARIO_NOW,
          deduplicated: false,
        }),
      );
    }
    return undefined;
  }

  const fetchStub = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== TEST_CONFIG.apiUrl) {
      return fleet.fetch(input, init);
    }
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : undefined;
    const answer = answerControl(method, url.pathname, body);
    if (answer === undefined) {
      return fleet.fetch(input, init);
    }
    requests.push({ method, path: url.pathname, search: url.search, body });
    return Promise.resolve(answer);
  });

  return {
    fetch: fetchStub,
    requests,
    sockets: fleet.sockets,
    createSocket: fleet.createSocket,
  };
}

/**
 * The command identifier of a request body, read through the protocol schema of the route.
 *
 * @param request - The recorded request.
 * @returns The identifier, or `undefined` when the body carries none.
 */
export function commandIdOf(request: ScenarioRequest): string | undefined {
  const parsed = LockRequestSchema.or(CommandRequestSchema).safeParse(parseBody(request.body));
  return parsed.success ? parsed.data.commandId : undefined;
}

/**
 * The command type of a recorded command request.
 *
 * @param request - The recorded request.
 * @returns The type, or `undefined` when the body is not a command.
 */
export function commandTypeOf(request: ScenarioRequest): string | undefined {
  const parsed = CommandRequestSchema.safeParse(parseBody(request.body));
  return parsed.success ? parsed.data.type : undefined;
}

/**
 * The robot's acknowledgement of a command, as a validated frame. It mirrors what the robot sends after it decided.
 *
 * @param commandId - The command being answered.
 * @param reason - The refusal reason, or `undefined` for an acceptance.
 * @returns The validated frame.
 */
export function ackFrame(commandId: string, reason?: AckReason): WsServerMessage {
  const base = {
    schemaVersion: "1.0.0",
    messageId: uuidv7(),
    robotId: SCENARIO_ROBOT,
    siteId: DEMO_SITE_ID,
    ts: SCENARIO_NOW,
    seq: 1,
    bootId: uuidv7(),
    commandId,
    correlationId: CORRELATION_ID,
    robotTs: SCENARIO_NOW,
    state: "IDLE",
  };
  const ack = AckSchema.parse(
    reason === undefined ? { ...base, result: "ACK" } : { ...base, result: "REJECT", reason },
  );
  return WsServerMessageSchema.parse({ type: "command.ack", siteId: DEMO_SITE_ID, ack });
}

/**
 * A `lock.changed` frame: the cloud announces who holds the scenario robot.
 *
 * @param held - Whether a holder exists.
 * @param holder - The holder, when held.
 * @returns The validated frame.
 */
export function lockChangedFrame(held: boolean, holder?: string): WsServerMessage {
  return WsServerMessageSchema.parse({
    type: "lock.changed",
    siteId: DEMO_SITE_ID,
    robotId: SCENARIO_ROBOT,
    held,
    holder,
    cause: held ? "ACQUIRED" : "RELEASED",
  });
}

/**
 * A delta that moves the scenario robot into the e-stop, one sequence number after its snapshot.
 *
 * @returns The validated frame.
 */
export function estopFrame(): WsServerMessage {
  return deltaOf([sampleOf(SCENARIO_ROBOT, 2, { state: "ESTOP" })]);
}
