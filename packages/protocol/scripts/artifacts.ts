/**
 * Pure builder for the generated protocol artifacts.
 *
 * Kept free of file-system access so that determinism and content can be unit tested.
 * The writer lives in `generate.ts`.
 *
 * Every artifact is derived from the TypeScript sources, and the Python agent is checked against the
 * same outputs by its parity tests: a change that is not regenerated fails there.
 */
import { z } from "zod";
import * as CONSTANTS from "../src/constants";
import {
  AckSchema,
  AdminInvokeEventSchema,
  AdminInvokeResultSchema,
  ALERT_LIST_MAX_LIMIT,
  AlertActionRequestSchema,
  AlertActionResponseSchema,
  AlertIdSchema,
  AlertListQuerySchema,
  AlertListResponseSchema,
  AlertRecordSchema,
  AUDIT_LIST_MAX_LIMIT,
  AuditListQuerySchema,
  AuditListResponseSchema,
  AuditRecordSchema,
  CLOUD_TRANSITIONS,
  CommandRequestSchema,
  CommandResponseSchema,
  CommandSchema,
  CommandTriggerSchema,
  DemoStateSchema,
  DemoUpdateRequestSchema,
  InternalTriggerSchema,
  LOCK_FREE_COMMANDS,
  LOCK_REQUIRED_COMMANDS,
  LockActionResponseSchema,
  LockRequestSchema,
  LockStateSchema,
  UNSUPPORTED_COMMANDS,
  HealthResponseSchema,
  MeSchema,
  IngestedTelemetrySchema,
  PrincipalSchema,
  ProblemSchema,
  RegisterRobotRequestSchema,
  RegisterRobotResponseSchema,
  RetireRobotRequestSchema,
  RetireRobotResponseSchema,
  RobotEventSchema,
  RobotIdSchema,
  RobotKitConfigSchema,
  RobotListResponseSchema,
  RobotLiveStateSchema,
  RobotSummarySchema,
  SiteIdSchema,
  SiteMapSchema,
  TelemetrySchema,
  TRANSITIONS,
  VideoClaimResponseSchema,
  VideoSessionSchema,
  VideoStatusSchema,
  WsClientMessageSchema,
  WsServerMessageSchema,
  WsTokenRequestSchema,
  WsTokenResponseSchema,
} from "../src/index";
import { TOPIC_VECTORS } from "./topic-vectors";
import { buildStateMachineDoc } from "./state-machine-doc";
import { sortedCloudRows, sortedRows } from "./state-machine-rows";

/**
 * Message schemas exported as JSON Schema for the Python agent and for OpenAPI consumers. The file
 * name is the schema name in kebab case, and the fixture corpus uses the same directory names.
 */
const JSON_SCHEMAS: readonly (readonly [string, z.ZodType])[] = [
  ["ack", AckSchema],
  ["admin-invoke-event", AdminInvokeEventSchema],
  ["admin-invoke-result", AdminInvokeResultSchema],
  ["alert-record", AlertRecordSchema],
  ["audit-list-response", AuditListResponseSchema],
  ["audit-record", AuditRecordSchema],
  ["command", CommandSchema],
  ["command-request", CommandRequestSchema],
  ["command-response", CommandResponseSchema],
  ["demo-state", DemoStateSchema],
  ["demo-update-request", DemoUpdateRequestSchema],
  ["ingested-telemetry", IngestedTelemetrySchema],
  ["lock-action-response", LockActionResponseSchema],
  ["lock-request", LockRequestSchema],
  ["lock-state", LockStateSchema],
  ["principal", PrincipalSchema],
  ["problem", ProblemSchema],
  ["register-robot-request", RegisterRobotRequestSchema],
  ["register-robot-response", RegisterRobotResponseSchema],
  ["retire-robot-request", RetireRobotRequestSchema],
  ["retire-robot-response", RetireRobotResponseSchema],
  ["robot-event", RobotEventSchema],
  ["robot-kit-config", RobotKitConfigSchema],
  ["robot-list-response", RobotListResponseSchema],
  ["robot-live-state", RobotLiveStateSchema],
  ["robot-summary", RobotSummarySchema],
  ["site-map", SiteMapSchema],
  ["telemetry", TelemetrySchema],
  ["video-claim-response", VideoClaimResponseSchema],
  ["video-session", VideoSessionSchema],
  ["video-status", VideoStatusSchema],
  ["ws-client-message", WsClientMessageSchema],
  ["ws-server-message", WsServerMessageSchema],
  ["ws-token-request", WsTokenRequestSchema],
  ["ws-token-response", WsTokenResponseSchema],
];

/**
 * Returns a copy of a JSON Schema without its `$schema` keyword.
 *
 * The keyword is valid at the root of a standalone schema, but OpenAPI components
 * reject it, so it must be removed when a schema is embedded.
 *
 * @param schema - A JSON Schema object produced by `z.toJSONSchema`.
 * @returns A new object without the `$schema` property.
 */
export function withoutSchemaKeyword(schema: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...schema };
  delete copy.$schema;
  return copy;
}

/** Serialises an artifact with two-space indentation and a trailing newline, as text editors expect. */
function serialise(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Every protocol constant, keyed by name and sorted, so that the Python side reads one object.
 *
 * @returns The constants object written to `generated/constants.json`.
 */
function constantsArtifact(): Record<string, unknown> {
  const values: Record<string, unknown> = {
    ...CONSTANTS,
    LOCK_REQUIRED_COMMANDS,
    LOCK_FREE_COMMANDS,
    UNSUPPORTED_COMMANDS,
  };
  return Object.fromEntries(
    Object.entries(values).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
}

/** Problem response of the HTTP API, as the OpenAPI media type `application/problem+json` documents it. */
function problemResponseOf(description: string): Record<string, unknown> {
  return {
    description,
    content: {
      "application/problem+json": {
        schema: { $ref: "#/components/schemas/Problem" },
      },
    },
  };
}

/** JSON body of a request or response, documented against a component schema. */
function jsonResponseOf(description: string, schema: string): Record<string, unknown> {
  return {
    description,
    content: {
      "application/json": { schema: { $ref: `#/components/schemas/${schema}` } },
    },
  };
}

/**
 * A query parameter of an operation, typed by the zod schema of the request. The schema is the input side,
 * so a defaulted member is documented as optional with its default.
 */
function queryParameterOf(
  name: string,
  schema: z.ZodType,
  description: string,
): Record<string, unknown> {
  return {
    name,
    in: "query",
    required: false,
    description,
    schema: withoutSchemaKeyword(z.toJSONSchema(schema, { target: "draft-2020-12", io: "input" })),
  };
}

/** A path parameter of an operation, typed by the zod schema of the identifier it carries. */
function pathParameterOf(
  name: string,
  schema: z.ZodType,
  description: string,
): Record<string, unknown> {
  return {
    name,
    in: "path",
    required: true,
    description,
    schema: withoutSchemaKeyword(z.toJSONSchema(schema, { target: "draft-2020-12" })),
  };
}

/** The 401 of an unauthenticated request: API Gateway answers it, so the Lambda never does. */
const UNAUTHORIZED = { description: "Missing or invalid access token (answered by API Gateway)." };

/** Requests that carry an access token must send it as a bearer credential. */
const BEARER_SECURITY = [{ bearer: [] }];

/**
 * One operator action on an alert: a POST with the locator body, its responses and its documented errors.
 *
 * @param operationId - The operation identifier, unique in the document.
 * @param summary - One-line description of the action.
 * @returns The operation object.
 */
function alertActionOperation(operationId: string, summary: string): Record<string, unknown> {
  return {
    operationId,
    summary,
    security: BEARER_SECURITY,
    parameters: [
      pathParameterOf("siteId", SiteIdSchema, "Site identifier."),
      pathParameterOf("alertId", AlertIdSchema, "Alert identifier."),
    ],
    requestBody: {
      required: true,
      content: {
        "application/json": { schema: { $ref: "#/components/schemas/AlertActionRequest" } },
      },
    },
    responses: {
      "200": jsonResponseOf("The alert after the action.", "AlertActionResponse"),
      "400": problemResponseOf("The body does not match the schema."),
      "401": UNAUTHORIZED,
      "403": problemResponseOf("The caller may not change alerts, or has no access to the site."),
      "404": problemResponseOf("No alert matches the identifier and the opening time."),
      "409": problemResponseOf("The alert is not in a state that allows this action."),
      "413": problemResponseOf("The body is larger than 16 KiB."),
      "500": problemResponseOf("Internal error."),
    },
  };
}

/** A JSON request body documented against a component schema. */
function jsonRequestBodyOf(schema: string): Record<string, unknown> {
  return {
    required: true,
    content: {
      "application/json": { schema: { $ref: `#/components/schemas/${schema}` } },
    },
  };
}

/** The path parameters of a route that names one robot of a site. */
function robotParametersOf(): Record<string, unknown>[] {
  return [
    pathParameterOf("siteId", SiteIdSchema, "Site identifier."),
    pathParameterOf("robotId", RobotIdSchema, "Robot identifier."),
  ];
}

/**
 * The OpenAPI 3.1.1 document of the HTTP API. Every error response is `application/problem+json`; the 401 of an
 * unauthenticated request is written by API Gateway, not by the Lambda, and is documented as such.
 *
 * @returns The document, as a plain object ready for serialisation.
 */
function openApiDocument(): Record<string, unknown> {
  const options = { target: "draft-2020-12" } as const;
  const component = (schema: z.ZodType): Record<string, unknown> =>
    withoutSchemaKeyword(z.toJSONSchema(schema, options));
  return {
    openapi: "3.1.1",
    info: {
      title: "Fleet Console API",
      version: "0.0.0",
      description: "Generated from packages/protocol.",
    },
    paths: {
      "/health": {
        get: {
          operationId: "getHealth",
          summary: "Liveness report. Public, no authentication.",
          responses: {
            "200": jsonResponseOf("The service is up.", "HealthResponse"),
            "500": problemResponseOf("Internal error."),
          },
        },
      },
      "/me": {
        get: {
          operationId: "getMe",
          summary: "Identity of the caller.",
          security: BEARER_SECURITY,
          responses: {
            "200": jsonResponseOf("The caller.", "Me"),
            "401": UNAUTHORIZED,
            "403": problemResponseOf("The token does not grant a console role."),
            "500": problemResponseOf("Internal error."),
          },
        },
      },
      "/ws-token": {
        post: {
          operationId: "postWsToken",
          summary: "Issue a single-use token for one WebSocket connection.",
          security: BEARER_SECURITY,
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/WsTokenRequest" } },
            },
          },
          responses: {
            "200": jsonResponseOf("The token and the WebSocket URL.", "WsTokenResponse"),
            "400": problemResponseOf(
              "The body does not match the schema, or the session window is invalid.",
            ),
            "401": UNAUTHORIZED,
            "403": problemResponseOf("The caller has no access to the requested site."),
            "413": problemResponseOf("The body is larger than 16 KiB."),
            "500": problemResponseOf("Internal error."),
          },
        },
      },
      "/sites/{siteId}/alerts": {
        get: {
          operationId: "listAlerts",
          summary: "List the active or resolved alerts of a site, one page per request.",
          security: BEARER_SECURITY,
          parameters: [
            pathParameterOf("siteId", SiteIdSchema, "Site identifier."),
            queryParameterOf(
              "status",
              AlertListQuerySchema.shape.status,
              "Open alerts (active) or alerts resolved in the window (resolved).",
            ),
            queryParameterOf("severity", AlertListQuerySchema.shape.severity, "Severity filter."),
            queryParameterOf("robotId", AlertListQuerySchema.shape.robotId, "Robot filter."),
            queryParameterOf(
              "since",
              AlertListQuerySchema.shape.since,
              "Earliest resolution time. Only with status=resolved.",
            ),
            queryParameterOf(
              "limit",
              AlertListQuerySchema.shape.limit,
              `Page size, from 1 to ${String(ALERT_LIST_MAX_LIMIT)}.`,
            ),
            queryParameterOf(
              "cursor",
              AlertListQuerySchema.shape.cursor,
              "Cursor of the next page.",
            ),
          ],
          responses: {
            "200": jsonResponseOf("One page of alerts.", "AlertListResponse"),
            "400": problemResponseOf(
              "A parameter does not match the schema, or the cursor is not valid.",
            ),
            "401": UNAUTHORIZED,
            "403": problemResponseOf("The caller has no console role, or no access to the site."),
            "500": problemResponseOf("Internal error."),
          },
        },
      },
      "/sites/{siteId}/alerts/{alertId}/acknowledge": {
        post: alertActionOperation("acknowledgeAlert", "Acknowledge an open alert."),
      },
      "/sites/{siteId}/alerts/{alertId}/resolve": {
        post: alertActionOperation("resolveAlert", "Resolve an acknowledged alert."),
      },
      "/sites/{siteId}/robots": {
        get: {
          operationId: "listRobots",
          summary: "List the robots of a site, as summaries only.",
          security: BEARER_SECURITY,
          parameters: [pathParameterOf("siteId", SiteIdSchema, "Site identifier.")],
          responses: {
            "200": jsonResponseOf("The registry entries of the site.", "RobotListResponse"),
            "401": UNAUTHORIZED,
            "403": problemResponseOf("The caller has no console role, or no access to the site."),
            "500": problemResponseOf("Internal error."),
          },
        },
      },
      "/sites/{siteId}/robots/{robotId}/commands": {
        post: {
          operationId: "sendCommand",
          summary:
            "Send one command to a robot. Admin and Operator only; SIMULATE_FAULT is Admin only.",
          security: BEARER_SECURITY,
          parameters: robotParametersOf(),
          requestBody: jsonRequestBodyOf("CommandRequest"),
          responses: {
            "200": jsonResponseOf(
              "The command was accepted, or it was already accepted and is returned again (deduplicated).",
              "CommandResponse",
            ),
            "400": problemResponseOf("The body does not match the schema of its command type."),
            "401": UNAUTHORIZED,
            "403": problemResponseOf("The caller may not send this command to this site."),
            "404": problemResponseOf("The robot is not in the registry of the site."),
            "409": problemResponseOf(
              "The command does not fit the current state: no lock held, another holder, demo mode off, robot not simulated, robot retired, or the command identifier was used for another command.",
            ),
            "413": problemResponseOf("The body is larger than 2 KiB."),
            "429": problemResponseOf(
              "The caller sent too many commands in the window. E-stop is never limited.",
            ),
            "500": problemResponseOf("Internal error."),
            "502": problemResponseOf(
              "The command could not be published. The same command identifier may be sent again.",
            ),
            "503": problemResponseOf(
              "The request ran out of time before the command was published. Nothing was published.",
            ),
          },
        },
      },
      "/sites/{siteId}/robots/{robotId}/lock": {
        get: {
          operationId: "getLock",
          summary: "State of the robot lock as the caller sees it. The token is never returned.",
          security: BEARER_SECURITY,
          parameters: robotParametersOf(),
          responses: {
            "200": jsonResponseOf("The state of the lock.", "LockState"),
            "401": UNAUTHORIZED,
            "403": problemResponseOf("The caller has no console role, or no access to the site."),
            "500": problemResponseOf("Internal error."),
          },
        },
        post: {
          operationId: "acquireLock",
          summary: "Take control of a robot. Admin and Operator only.",
          security: BEARER_SECURITY,
          parameters: robotParametersOf(),
          requestBody: jsonRequestBodyOf("LockRequest"),
          responses: {
            "200": jsonResponseOf("The lock is held by the caller.", "LockActionResponse"),
            "400": problemResponseOf("The body does not match the schema."),
            "401": UNAUTHORIZED,
            "403": problemResponseOf(
              "The caller may not take control, or has no access to the site.",
            ),
            "404": problemResponseOf("The robot is not in the registry of the site."),
            "409": problemResponseOf("Another operator holds the lock, or the robot is retired."),
            "413": problemResponseOf("The body is larger than 2 KiB."),
            "500": problemResponseOf("Internal error."),
            "502": problemResponseOf(
              "The take-control command could not be published. The lock was not kept.",
            ),
          },
        },
      },
      "/sites/{siteId}/robots/{robotId}/lock/release": {
        post: {
          operationId: "releaseLock",
          summary: "Release the lock the caller holds.",
          security: BEARER_SECURITY,
          parameters: robotParametersOf(),
          requestBody: jsonRequestBodyOf("LockRequest"),
          responses: {
            "200": jsonResponseOf(
              "The lock is released, or was already free (changed is false).",
              "LockActionResponse",
            ),
            "400": problemResponseOf("The body does not match the schema."),
            "401": UNAUTHORIZED,
            "403": problemResponseOf(
              "The caller may not release control, or has no access to the site.",
            ),
            "404": problemResponseOf("The robot is not in the registry of the site."),
            "409": problemResponseOf("Another operator holds the lock."),
            "413": problemResponseOf("The body is larger than 2 KiB."),
            "500": problemResponseOf("Internal error."),
            "502": problemResponseOf(
              "The release command could not be published. The lock is kept so the release can be retried.",
            ),
          },
        },
      },
      "/sites/{siteId}/demo": {
        get: {
          operationId: "getDemo",
          summary: "Demo mode of a site. Every console role may read it.",
          security: BEARER_SECURITY,
          parameters: [pathParameterOf("siteId", SiteIdSchema, "Site identifier.")],
          responses: {
            "200": jsonResponseOf("The demo mode of the site.", "DemoState"),
            "401": UNAUTHORIZED,
            "403": problemResponseOf("The caller has no console role, or no access to the site."),
            "500": problemResponseOf("Internal error."),
          },
        },
        put: {
          operationId: "setDemo",
          summary: "Switch the demo mode of a site. Admin only.",
          security: BEARER_SECURITY,
          parameters: [pathParameterOf("siteId", SiteIdSchema, "Site identifier.")],
          requestBody: jsonRequestBodyOf("DemoUpdateRequest"),
          responses: {
            "200": jsonResponseOf("The demo mode after the change.", "DemoState"),
            "400": problemResponseOf("The body does not match the schema."),
            "401": UNAUTHORIZED,
            "403": problemResponseOf("The caller is not an Admin, or has no access to the site."),
            "413": problemResponseOf("The body is larger than 2 KiB."),
            "500": problemResponseOf("Internal error."),
          },
        },
      },
      "/sites/{siteId}/audit": {
        get: {
          operationId: "listAudit",
          summary: "List the audit records of a site, newest first, one page per request.",
          security: BEARER_SECURITY,
          parameters: [
            pathParameterOf("siteId", SiteIdSchema, "Site identifier."),
            queryParameterOf(
              "limit",
              AuditListQuerySchema.shape.limit,
              `Page size, from 1 to ${String(AUDIT_LIST_MAX_LIMIT)}.`,
            ),
            queryParameterOf(
              "cursor",
              AuditListQuerySchema.shape.cursor,
              "Cursor of the next page.",
            ),
            queryParameterOf(
              "robotId",
              AuditListQuerySchema.shape.robotId,
              "Only the records of this robot.",
            ),
            queryParameterOf(
              "result",
              AuditListQuerySchema.shape.result,
              "Only the records with this outcome.",
            ),
          ],
          responses: {
            "200": jsonResponseOf("One page of audit records.", "AuditListResponse"),
            "400": problemResponseOf(
              "A parameter does not match the schema, or the cursor is not valid.",
            ),
            "401": UNAUTHORIZED,
            "403": problemResponseOf("The caller has no console role, or no access to the site."),
            "500": problemResponseOf("Internal error."),
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearer: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      },
      schemas: {
        HealthResponse: component(HealthResponseSchema),
        Me: component(MeSchema),
        Problem: component(ProblemSchema),
        WsTokenRequest: component(WsTokenRequestSchema),
        WsTokenResponse: component(WsTokenResponseSchema),
        AlertRecord: component(AlertRecordSchema),
        AlertListResponse: component(AlertListResponseSchema),
        AlertActionRequest: component(AlertActionRequestSchema),
        AlertActionResponse: component(AlertActionResponseSchema),
        AuditRecord: component(AuditRecordSchema),
        AuditListResponse: component(AuditListResponseSchema),
        CommandRequest: component(CommandRequestSchema),
        CommandResponse: component(CommandResponseSchema),
        DemoState: component(DemoStateSchema),
        DemoUpdateRequest: component(DemoUpdateRequestSchema),
        LockRequest: component(LockRequestSchema),
        LockState: component(LockStateSchema),
        LockActionResponse: component(LockActionResponseSchema),
        RobotSummary: component(RobotSummarySchema),
        RobotListResponse: component(RobotListResponseSchema),
      },
    },
  };
}

/**
 * Builds every generated artifact in memory.
 *
 * Keys are repository-relative POSIX paths. The output is deterministic: calling the
 * function twice yields identical content, so regenerating must leave no diff.
 *
 * @returns A map from repository-relative path to file content.
 */
export function buildArtifacts(): ReadonlyMap<string, string> {
  const options = { target: "draft-2020-12" } as const;

  const artifacts = new Map<string, string>([
    [
      "packages/protocol/generated/robot-id.schema.json",
      serialise(z.toJSONSchema(RobotIdSchema, options)),
    ],
    [
      "packages/protocol/generated/site-id.schema.json",
      serialise(z.toJSONSchema(SiteIdSchema, options)),
    ],
    [
      "packages/protocol/generated/health-response.schema.json",
      serialise(z.toJSONSchema(HealthResponseSchema, options)),
    ],
    ["services/api/openapi.json", serialise(openApiDocument())],
    ["packages/protocol/generated/constants.json", serialise(constantsArtifact())],
    [
      "packages/protocol/generated/state-machine.json",
      serialise({
        triggers: {
          command: CommandTriggerSchema.options,
          internal: InternalTriggerSchema.options,
        },
        rows: sortedRows(TRANSITIONS),
        cloudRows: sortedCloudRows(CLOUD_TRANSITIONS),
      }),
    ],
    ["packages/protocol/generated/topic-vectors.json", serialise(TOPIC_VECTORS)],
    ["docs/STATE_MACHINE.md", buildStateMachineDoc()],
  ]);

  for (const [name, schema] of JSON_SCHEMAS) {
    artifacts.set(
      `packages/protocol/generated/${name}.schema.json`,
      serialise(z.toJSONSchema(schema, options)),
    );
  }
  return artifacts;
}
