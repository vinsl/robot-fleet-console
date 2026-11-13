import { AuditCursorSchema, AuditListQuerySchema } from "@mfc/protocol";
import { describe, expect, it } from "vitest";
import { AUDIT_CURSOR_PROBLEM, listAudit } from "../../../src/domain/audit/list-audit";
import { auditRecordOf, auditWorld } from "../../fakes/audit";

const SITE = "paris-01";
const CURSOR = AuditCursorSchema.parse("eyJhIjoxfQ");

describe("listAudit", () => {
  it("passes the validated query to the reader and returns the page in store order", async () => {
    const world = auditWorld();
    const first = auditRecordOf({ auditId: "0190a0a0-0000-7000-8000-000000000002" });
    const second = auditRecordOf();
    world.reader.scriptedPage = { items: [first, second], invalidItems: 0, nextCursor: CURSOR };

    const result = await listAudit(
      { reader: world.reader, logger: world.logger },
      SITE,
      AuditListQuerySchema.parse({ limit: "20", cursor: CURSOR }),
    );

    expect(world.reader.requests).toEqual([{ siteId: SITE, limit: 20, cursor: CURSOR }]);
    expect(result).toEqual({ ok: true, value: { items: [first, second], nextCursor: CURSOR } });
  });

  it("passes the robot and the outcome filters to the reader", async () => {
    const world = auditWorld();

    await listAudit(
      { reader: world.reader, logger: world.logger },
      SITE,
      AuditListQuerySchema.parse({ robotId: "sim-03", result: "REFUSED" }),
    );

    expect(world.reader.requests).toEqual([
      { siteId: SITE, limit: 50, cursor: undefined, robotId: "sim-03", result: "REFUSED" },
    ]);
  });

  it("uses the default page size and omits nextCursor on the last page", async () => {
    const world = auditWorld();

    const result = await listAudit(
      { reader: world.reader, logger: world.logger },
      SITE,
      AuditListQuerySchema.parse({}),
    );

    expect(world.reader.requests).toEqual([{ siteId: SITE, limit: 50, cursor: undefined }]);
    expect(result).toEqual({ ok: true, value: { items: [] } });
    if (result.ok) {
      expect(result.value).not.toHaveProperty("nextCursor");
    }
  });

  it("refuses a cursor of another site with 400 and writes no internal text", async () => {
    const world = auditWorld();
    world.reader.refuseCursor();

    const result = await listAudit(
      { reader: world.reader, logger: world.logger },
      SITE,
      AuditListQuerySchema.parse({ cursor: CURSOR }),
    );

    expect(result).toEqual({ ok: false, problem: AUDIT_CURSOR_PROBLEM });
    expect(AUDIT_CURSOR_PROBLEM).toMatchObject({ type: "invalid-request", status: 400 });
    expect(world.logger.text()).not.toContain(CURSOR);
  });

  it("rethrows any other reader failure", async () => {
    const world = auditWorld();
    world.reader.error = new Error("dynamodb unavailable");

    await expect(
      listAudit(
        { reader: world.reader, logger: world.logger },
        SITE,
        AuditListQuerySchema.parse({}),
      ),
    ).rejects.toThrow("dynamodb unavailable");
  });

  it("counts the stored items left out in one log line and keeps the valid ones", async () => {
    const world = auditWorld();
    const valid = auditRecordOf();
    world.reader.scriptedPage = { items: [valid], invalidItems: 2 };

    const result = await listAudit(
      { reader: world.reader, logger: world.logger },
      SITE,
      AuditListQuerySchema.parse({}),
    );

    expect(result).toEqual({ ok: true, value: { items: [valid] } });
    expect(
      world.logger.entries.filter((entry) => entry.message === "stored audit items left out"),
    ).toEqual([expect.objectContaining({ attributes: { count: 2 } })]);
  });
});
