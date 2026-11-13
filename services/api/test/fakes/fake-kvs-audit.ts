/**
 * In-memory video channels and audit trail.
 */
import type { AuditRecord, ThingName } from "@mfc/protocol";
import type { ResourceTags } from "../../src/config/env";
import type { AuditPort, KvsPort } from "../../src/domain/ports";
import { CallGate } from "./call-gate";

/** Account identifier used in fake channel ARNs. Fake, and not a real account. */
const FAKE_ACCOUNT_ID = "123456789012";

/** A channel held by the fake. */
export interface FakeChannel {
  readonly arn: string;
  readonly tags: ResourceTags;
}

/** Operations of the video fake, the names used by failure injection. */
export type KvsMethod = keyof KvsPort;

/** Video channel fake: create and delete, with the outcomes of the adapter. */
export class FakeKvs implements KvsPort {
  /** Channels by name. */
  readonly channels = new Map<string, FakeChannel>();
  /** Calls and scripted failures, logged into the shared call log. */
  readonly gate: CallGate<KvsMethod>;
  private serial = 1000;

  /** @param log - The shared call log of the IoT and video fakes. */
  constructor(log: string[]) {
    this.gate = new CallGate(log, "kvs");
  }

  /**
   * @param name - Channel name.
   * @param tags - Tags of the channel.
   * @returns The ARN of the channel, created or already present.
   */
  async createChannel(name: ThingName, tags: ResourceTags): Promise<{ channelArn: string }> {
    await this.gate.enter("createChannel");
    const existing = this.channels.get(name);
    if (existing !== undefined) {
      return { channelArn: existing.arn };
    }
    this.serial += 1;
    const arn = `arn:aws:kinesisvideo:eu-west-3:${FAKE_ACCOUNT_ID}:channel/${name}/${String(this.serial)}`;
    this.channels.set(name, { arn, tags });
    return { channelArn: arn };
  }

  /**
   * @param name - Channel name.
   * @returns `deleted` when this call removed the channel, otherwise `absent`.
   */
  async deleteChannel(name: ThingName): Promise<"deleted" | "absent"> {
    await this.gate.enter("deleteChannel");
    return this.channels.delete(name) ? "deleted" : "absent";
  }
}

/** Audit trail fake: keeps every record it accepts. */
export class FakeAudit implements AuditPort {
  /** Accepted records, in order. */
  readonly records: AuditRecord[] = [];
  /** Calls and scripted failures. Kept apart from the IoT and video log. */
  readonly gate = new CallGate<"write">([], "audit");

  /**
   * @param record - The record to append.
   */
  async write(record: AuditRecord): Promise<void> {
    await this.gate.enter("write");
    this.records.push(record);
  }
}
