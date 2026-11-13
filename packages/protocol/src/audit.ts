/**
 * Audit record of an action that changes the fleet: registry administration, site and map edits, alert
 * actions, the robot control plane and the demo mode.
 *
 * One record is written per attempt that reaches the domain, after its outcome is known. The record
 * names who acted, on which robot, and how it ended. It carries no key material and no ARN: the
 * certificate and channel identifiers stay in the registry, where the operator can read them.
 */
import { z } from "zod";
import { PROBLEM_TYPES } from "./problem";
import { ActorSchema, CorrelationIdSchema, RobotIdSchema, SiteIdSchema } from "./ids";
import { AlertIdSchema } from "./alerts";
import { IsoMsSchema } from "./time";
import { MapVersionNumberSchema } from "./site";
import { Uuidv7Schema } from "./uuidv7";

/**
 * Actions that write an audit record. The `robots.*` names are the actions of `AdminInvokeEventSchema`;
 * the `site.*` names are the actions of the site API; the `alert.*` names are the operator actions on an
 * alert; the `lock.*` and `command.*` names are the control plane of a robot; the `demo.*` names switch
 * the demo mode of a site.
 */
export const AuditActionSchema = z.enum([
  "robots.register",
  "robots.retire",
  "site.update",
  "site.map.create",
  "site.map.validate",
  "site.map.activate",
  "alert.acknowledge",
  "alert.resolve",
  "lock.acquire",
  "lock.release",
  "command.pause",
  "command.resume",
  "command.return_to_base",
  "command.estop",
  "command.estop_release",
  "command.simulate_fault",
  "demo.enable",
  "demo.disable",
]);

/** A validated audit action. */
export type AuditAction = z.infer<typeof AuditActionSchema>;

/**
 * Outcome of an audited action. `REFUSED` is a business refusal (the request was valid but not allowed
 * in the current state); `FAILED` is an operation that started and did not finish.
 */
export const AuditResultSchema = z.enum(["SUCCEEDED", "REFUSED", "FAILED"]);

/** A validated audit outcome. */
export type AuditResult = z.infer<typeof AuditResultSchema>;

/**
 * One audit record. Strict, so that nothing beyond the audited facts can be stored by mistake.
 *
 * The problem type is present exactly when the outcome is not a success, so a reader never has to guess
 * whether a missing type means "no failure" or "not recorded".
 *
 * The robot is present for the `robots.*`, `alert.*`, `lock.*` and `command.*` actions and absent for the
 * others: a site action targets the site, and naming a robot there would make the robot index list an
 * action that did not concern it. An alert action concerns the robot of the alert, so the robot index
 * lists it on the robot timeline. The alert is present exactly on the `alert.*` actions. The map version is present
 * exactly on the `site.map.*` actions, and it is the version number of the site map contract.
 */
export const AuditRecordSchema = z
  .strictObject({
    auditId: Uuidv7Schema,
    ts: IsoMsSchema,
    siteId: SiteIdSchema,
    robotId: RobotIdSchema.optional(),
    alertId: AlertIdSchema.optional(),
    commandId: Uuidv7Schema.optional(),
    actor: ActorSchema,
    actorSource: z.enum(["mfc.admin", "mfc.jwt"]),
    action: AuditActionSchema,
    result: AuditResultSchema,
    problemType: z.enum(PROBLEM_TYPES).optional(),
    mapVersion: MapVersionNumberSchema.optional(),
    correlationId: CorrelationIdSchema,
  })
  .superRefine((record, ctx) => {
    const hasProblem = record.problemType !== undefined;
    const expectsProblem = record.result !== "SUCCEEDED";
    if (hasProblem !== expectsProblem) {
      ctx.addIssue({
        code: "custom",
        path: ["problemType"],
        message: "problem type is present exactly when the result is not SUCCEEDED",
      });
    }

    const namesRobot =
      record.action.startsWith("robots.") ||
      record.action.startsWith("alert.") ||
      record.action.startsWith("lock.") ||
      record.action.startsWith("command.");
    const hasRobot = record.robotId !== undefined;
    if (namesRobot !== hasRobot) {
      ctx.addIssue({
        code: "custom",
        path: ["robotId"],
        message: "a robot, alert, lock or command action names its robot, and others name none",
      });
    }

    const isAlertAction = record.action.startsWith("alert.");
    const hasAlert = record.alertId !== undefined;
    if (isAlertAction !== hasAlert) {
      ctx.addIssue({
        code: "custom",
        path: ["alertId"],
        message: "an alert action names its alert, and no other action does",
      });
    }

    const isCommandAction = record.action.startsWith("command.");
    const hasCommandId = record.commandId !== undefined;
    if (isCommandAction !== hasCommandId) {
      ctx.addIssue({
        code: "custom",
        path: ["commandId"],
        message: "a command action names its command identifier, and no other action does",
      });
    }

    const isMapAction = record.action.startsWith("site.map.");
    const hasMapVersion = record.mapVersion !== undefined;
    if (isMapAction !== hasMapVersion) {
      ctx.addIssue({
        code: "custom",
        path: ["mapVersion"],
        message: "a map action names its map version, and no other action does",
      });
    }
  });

/** A validated audit record. */
export type AuditRecord = z.infer<typeof AuditRecordSchema>;
