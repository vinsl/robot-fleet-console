/**
 * Use case: acknowledge or resolve an alert.
 *
 * The state of the alert is read again when the transaction loses its condition, so a concurrent change is
 * answered with the state that actually holds, never with a stale plan. The audit record and the change are one
 * transaction (ADR 0061): a transition without its audit line cannot be stored.
 */
import type {
  AlertAction,
  AlertActionRequest,
  AlertActionResponse,
  AlertId,
  AlertRecord,
  SiteId,
} from "@mfc/protocol";
import { writeAlertAudit, alertAuditRecord } from "./audit";
import { acknowledged, actionInstant, planOf, resolved } from "./lifecycle";
import { ALERT_PROBLEMS } from "./problems";
import type { AlertCall, AlertsDeps } from "./ports";
import { refuse, succeed, type UseCaseResult } from "../result";

/**
 * Remaining time below which the relay is skipped. The push to the consoles needs its own round trips, and a
 * push cut by the function timeout would leave the frame half sent; the consoles refetch on their timer anyway.
 */
const RELAY_MIN_REMAINING_MS = 1500;

/** Facts of one operator action: its audit name, the change it announces, and its counter. */
interface ActionFacts {
  readonly audit: "alert.acknowledge" | "alert.resolve";
  readonly change: "ACKNOWLEDGED" | "RESOLVED";
  readonly metric: "AlertAcknowledged" | "AlertResolved";
}

/**
 * Facts of an operator action.
 *
 * @param action - The operator action.
 * @returns Its audit name, announced change and counter.
 */
function factsOf(action: AlertAction): ActionFacts {
  switch (action) {
    case "acknowledge":
      return { audit: "alert.acknowledge", change: "ACKNOWLEDGED", metric: "AlertAcknowledged" };
    case "resolve":
      return { audit: "alert.resolve", change: "RESOLVED", metric: "AlertResolved" };
  }
}

/** Outcome of one read-plan-write attempt: final, or lost to a concurrent change. */
type Attempt =
  | { readonly kind: "done"; readonly result: UseCaseResult<AlertActionResponse> }
  | { readonly kind: "conflict"; readonly current: AlertRecord };

/**
 * Applies an operator action to an alert, at most twice.
 *
 * An action already in its target state is answered with `changed: false` and writes nothing. A conflicting
 * concurrent change is retried once from a fresh read; a second conflict is refused and audited.
 *
 * @param deps - The store, relay, clock, identifiers, deadline, logger and metrics of the alerts use cases.
 * @param call - The verified caller and the correlation identifier.
 * @param action - The operator action.
 * @param siteId - The verified site of the caller.
 * @param alertId - The identifier of the alert, from the path.
 * @param request - The locator of the alert, from the body.
 * @returns The alert after the action and whether it changed, or the refusal.
 */
export async function actOnAlert(
  deps: AlertsDeps,
  call: AlertCall,
  action: AlertAction,
  siteId: SiteId,
  alertId: AlertId,
  request: AlertActionRequest,
): Promise<UseCaseResult<AlertActionResponse>> {
  const first = await attempt(deps, call, action, siteId, alertId, request);
  if (first.kind === "done") {
    return first.result;
  }
  const second = await attempt(deps, call, action, siteId, alertId, request);
  if (second.kind === "done") {
    return second.result;
  }
  deps.metrics.count("AlertActionRefused");
  await writeAlertAudit(deps, {
    siteId,
    robotId: second.current.robotId,
    alertId,
    actor: call.actor,
    action: factsOf(action).audit,
    result: "REFUSED",
    problemType: ALERT_PROBLEMS.changed.type,
    correlationId: call.correlationId,
  });
  return refuse(ALERT_PROBLEMS.changed);
}

/**
 * One read-plan-write attempt of {@link actOnAlert}.
 *
 * @returns The final outcome, or `conflict` with the alert as it was read, when the transaction lost its condition.
 */
async function attempt(
  deps: AlertsDeps,
  call: AlertCall,
  action: AlertAction,
  siteId: SiteId,
  alertId: AlertId,
  request: AlertActionRequest,
): Promise<Attempt> {
  const { store, clock, metrics, logger, deadline, relay } = deps;
  const facts = factsOf(action);

  const current = await store.get(siteId, alertId, request.openedAt);
  if (current === null) {
    metrics.count("AlertNotFound");
    logger.warn("alert not found", { reason: "not-found" });
    return { kind: "done", result: refuse(ALERT_PROBLEMS.notFound) };
  }

  const plan = planOf(action, current.status);
  if (plan === "replay") {
    metrics.count("AlertActionReplayed");
    return { kind: "done", result: succeed({ alert: current, changed: false }) };
  }
  if (plan !== "apply") {
    metrics.count("AlertActionRefused");
    await writeAlertAudit(deps, {
      siteId,
      robotId: current.robotId,
      alertId,
      actor: call.actor,
      action: facts.audit,
      result: "REFUSED",
      problemType: plan.refuse.type,
      correlationId: call.correlationId,
    });
    return { kind: "done", result: refuse(plan.refuse) };
  }

  const at = actionInstant(clock.now(), current.openedAt);
  const next =
    action === "acknowledge"
      ? acknowledged(current, call.actor, at)
      : resolved(current, call.actor, at);
  const transition = {
    current,
    next,
    audit: alertAuditRecord(deps, {
      at,
      siteId,
      robotId: current.robotId,
      alertId,
      actor: call.actor,
      action: facts.audit,
      result: "SUCCEEDED",
      correlationId: call.correlationId,
    }),
  };
  const outcome =
    action === "acknowledge"
      ? await store.acknowledge(transition)
      : await store.resolve(transition);
  if (outcome === "CONFLICT") {
    return { kind: "conflict", current };
  }

  metrics.count(facts.metric);
  if (deadline.remainingMs() > RELAY_MIN_REMAINING_MS) {
    await relay.alertChanged(siteId, facts.change, next);
  } else {
    metrics.count("AlertRelaySkipped");
  }
  return { kind: "done", result: succeed({ alert: next, changed: true }) };
}
