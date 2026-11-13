import { describe, expect, it } from "vitest";
import { VideoPageError } from "../src/lib/errors";
import { endpointsByProtocol, type ResourceEndpointLike } from "../src/lib/endpoints";

const WSS = "wss://r-0123abcd.kinesisvideo.eu-west-3.amazonaws.com";
const HTTPS = "https://r-0123abcd.kinesisvideo.eu-west-3.amazonaws.com";

/**
 * Asserts that a call throws the page error for an unexpected endpoint.
 *
 * @param call - The call under test.
 */
function expectUnexpectedEndpoint(call: () => unknown): void {
  let caught: unknown = null;
  try {
    call();
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(VideoPageError);
  expect(caught).toHaveProperty("code", "ENDPOINT_UNEXPECTED");
}

describe("endpointsByProtocol", () => {
  it("returns the WSS and HTTPS endpoints of the region", () => {
    const list: ResourceEndpointLike[] = [
      { Protocol: "WSS", ResourceEndpoint: WSS },
      { Protocol: "HTTPS", ResourceEndpoint: HTTPS },
    ];

    expect(endpointsByProtocol(list, "eu-west-3")).toEqual({ wss: WSS, https: HTTPS });
  });

  it("takes the first entry of each protocol and ignores the others", () => {
    const list: ResourceEndpointLike[] = [
      { Protocol: "WEBRTC", ResourceEndpoint: "https://webrtc.example.com" },
      { Protocol: "HTTPS", ResourceEndpoint: HTTPS },
      { Protocol: "WSS", ResourceEndpoint: WSS },
      { Protocol: "WSS", ResourceEndpoint: "wss://other.kinesisvideo.eu-west-3.amazonaws.com" },
    ];

    expect(endpointsByProtocol(list, "eu-west-3").wss).toBe(WSS);
  });

  it("accepts the default port 443 written explicitly", () => {
    const list: ResourceEndpointLike[] = [
      { Protocol: "WSS", ResourceEndpoint: `${WSS}:443` },
      { Protocol: "HTTPS", ResourceEndpoint: HTTPS },
    ];

    expect(endpointsByProtocol(list, "eu-west-3").wss).toBe(`${WSS}:443`);
  });

  it("throws ENDPOINT_UNEXPECTED when the HTTPS endpoint is absent", () => {
    expectUnexpectedEndpoint(() =>
      endpointsByProtocol([{ Protocol: "WSS", ResourceEndpoint: WSS }], "eu-west-3"),
    );
  });

  it("throws ENDPOINT_UNEXPECTED for a WSS endpoint on another host", () => {
    const list: ResourceEndpointLike[] = [
      { Protocol: "WSS", ResourceEndpoint: "wss://evil.example.com" },
      { Protocol: "HTTPS", ResourceEndpoint: HTTPS },
    ];

    expectUnexpectedEndpoint(() => endpointsByProtocol(list, "eu-west-3"));
  });

  it("throws ENDPOINT_UNEXPECTED for an HTTPS endpoint on plain http", () => {
    const list: ResourceEndpointLike[] = [
      { Protocol: "WSS", ResourceEndpoint: WSS },
      { Protocol: "HTTPS", ResourceEndpoint: HTTPS.replace("https:", "http:") },
    ];

    expectUnexpectedEndpoint(() => endpointsByProtocol(list, "eu-west-3"));
  });

  it("throws ENDPOINT_UNEXPECTED for an endpoint of the fallback region when the session is eu-west-3", () => {
    const list: ResourceEndpointLike[] = [
      { Protocol: "WSS", ResourceEndpoint: WSS.replace("eu-west-3", "eu-west-1") },
      { Protocol: "HTTPS", ResourceEndpoint: HTTPS },
    ];

    expectUnexpectedEndpoint(() => endpointsByProtocol(list, "eu-west-3"));
  });

  it("throws ENDPOINT_UNEXPECTED for a non-default port", () => {
    const list: ResourceEndpointLike[] = [
      { Protocol: "WSS", ResourceEndpoint: `${WSS}:8443` },
      { Protocol: "HTTPS", ResourceEndpoint: HTTPS },
    ];

    expectUnexpectedEndpoint(() => endpointsByProtocol(list, "eu-west-3"));
  });

  it("throws ENDPOINT_UNEXPECTED for an entry without a URL", () => {
    const list: ResourceEndpointLike[] = [
      { Protocol: "WSS" },
      { Protocol: "HTTPS", ResourceEndpoint: HTTPS },
    ];

    expectUnexpectedEndpoint(() => endpointsByProtocol(list, "eu-west-3"));
  });

  it("throws ENDPOINT_UNEXPECTED for a string that is not a URL", () => {
    const list: ResourceEndpointLike[] = [
      { Protocol: "WSS", ResourceEndpoint: "not a url" },
      { Protocol: "HTTPS", ResourceEndpoint: HTTPS },
    ];

    expectUnexpectedEndpoint(() => endpointsByProtocol(list, "eu-west-3"));
  });

  it("throws ENDPOINT_UNEXPECTED for an undefined list", () => {
    expectUnexpectedEndpoint(() => endpointsByProtocol(undefined, "eu-west-3"));
  });
});
