/**
 * Runtime configuration schema: the console accepts only the shape the publish step writes.
 */
import { describe, expect, it } from "vitest";
import { RuntimeConfigSchema } from "../src/index";

const VALID = {
  apiUrl: "https://abc123defg.execute-api.eu-west-3.amazonaws.com",
  wsUrl: "wss://xyz987wvut.execute-api.eu-west-3.amazonaws.com/ws",
  region: "eu-west-3",
  userPoolId: "eu-west-3_EXAMPLE1",
  userPoolClientId: "examplecl1234567890example",
  identityPoolId: "eu-west-3:00000000-0000-0000-0000-000000000000",
};

describe("RuntimeConfigSchema", () => {
  it("accepts the configuration the publish step writes", () => {
    expect(RuntimeConfigSchema.parse(VALID)).toEqual(VALID);
  });

  it("accepts a multi-part region such as us-gov-west-1", () => {
    expect(RuntimeConfigSchema.safeParse({ ...VALID, region: "us-gov-west-1" }).success).toBe(true);
  });

  it.each([
    ["an HTTP API URL", { apiUrl: "http://abc.example.test" }],
    ["a realtime URL that is not WSS", { wsUrl: "https://abc.example.test/ws" }],
    ["a region without a dash", { region: "eu" }],
    ["a pool id with spaces", { userPoolId: "eu-west-3_ab cd" }],
    ["a client id with upper case", { userPoolClientId: "ABC" }],
    ["an identity pool id without a UUID", { identityPoolId: "eu-west-3:not-a-uuid" }],
    ["an extra key", { accountId: "123456789012" }],
  ])("rejects %s", (_label, override) => {
    expect(RuntimeConfigSchema.safeParse({ ...VALID, ...override }).success).toBe(false);
  });
});
