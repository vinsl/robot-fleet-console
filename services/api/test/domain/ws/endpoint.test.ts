/**
 * Tests of the management endpoint derived from the request context. The domain name is an address the
 * function posts to, so only the execute-api shape of this region is accepted.
 */
import { describe, expect, it } from "vitest";
import { managementEndpointOf } from "../../../src/domain/ws/endpoint";

const DOMAIN = "abc123.execute-api.eu-west-3.amazonaws.com";

describe("managementEndpointOf", () => {
  it("builds the HTTPS endpoint of the stage in this region", () => {
    expect(managementEndpointOf({ domainName: DOMAIN, stage: "live" }, "eu-west-3")).toBe(
      `https://${DOMAIN}/live`,
    );
  });

  it.each([
    ["another region than the function's", DOMAIN, "eu-west-1"],
    ["a foreign host", "evil.example", "eu-west-3"],
    ["a suffix attack", `${DOMAIN}.evil.example`, "eu-west-3"],
    ["an upper-case API id", "ABC123.execute-api.eu-west-3.amazonaws.com", "eu-west-3"],
    ["a path in the host", "abc123.execute-api.eu-west-3.amazonaws.com/x", "eu-west-3"],
    ["an unknown region", "abc123.execute-api.us-east-1.amazonaws.com", "eu-west-3"],
  ])("refuses a domain name of %s", (_label, domainName, region) => {
    expect(
      managementEndpointOf({ domainName, stage: "live" }, region as "eu-west-3" | "eu-west-1"),
    ).toBeNull();
  });

  it.each([
    ["a stage with a slash", "live/../x"],
    ["an empty stage", ""],
    ["an upper-case stage", "Live"],
  ])("refuses %s", (_label, stage) => {
    expect(managementEndpointOf({ domainName: DOMAIN, stage }, "eu-west-3")).toBeNull();
  });
});
