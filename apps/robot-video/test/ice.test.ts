import { describe, expect, it } from "vitest";
import { buildIceServers, type IceServerLike, stunUrl } from "../src/lib/ice";

const STUN = "stun:stun.kinesisvideo.eu-west-3.amazonaws.com:443";
const TURN_TCP = "turns:turn-a1.kinesisvideo.eu-west-3.amazonaws.com:443?transport=tcp";
const TURN_UDP = "turn:turn-b2.kinesisvideo.eu-west-3.amazonaws.com:443?transport=udp";

const VALID_TURN: IceServerLike = {
  Uris: [TURN_TCP, TURN_UDP],
  Username: "fake-user",
  Password: "fake-password",
};

describe("stunUrl", () => {
  it("returns the STUN URL of the KVS endpoint of the region", () => {
    expect(stunUrl("eu-west-3")).toBe(STUN);
  });
});

describe("buildIceServers", () => {
  it("returns only the STUN entry when there is no TURN server", () => {
    expect(buildIceServers("eu-west-3", undefined)).toEqual([{ urls: STUN }]);
    expect(buildIceServers("eu-west-3", [])).toEqual([{ urls: STUN }]);
  });

  it("puts STUN first, then one entry per valid TURN server with its credentials", () => {
    const servers = buildIceServers("eu-west-3", [
      VALID_TURN,
      { Uris: [TURN_UDP], Username: "u2", Password: "p2" },
    ]);

    expect(servers).toEqual([
      { urls: STUN },
      { urls: [TURN_TCP, TURN_UDP], username: "fake-user", credential: "fake-password" },
      { urls: [TURN_UDP], username: "u2", credential: "p2" },
    ]);
  });

  it("drops a TURN entry with a non-KVS host, a missing password or a stun URI", () => {
    const servers = buildIceServers("eu-west-3", [
      { Uris: ["turn:turn.example.com:3478"], Username: "u", Password: "p" },
      { Uris: [TURN_TCP], Username: "u" },
      {
        Uris: ["stun:stun.kinesisvideo.eu-west-3.amazonaws.com:443"],
        Username: "u",
        Password: "p",
      },
    ]);

    expect(servers).toEqual([{ urls: STUN }]);
  });

  it("drops the whole entry when one of its URIs points outside KVS", () => {
    const servers = buildIceServers("eu-west-3", [
      { Uris: [TURN_TCP, "turn:evil.example.com:3478"], Username: "u", Password: "p" },
    ]);

    expect(servers).toEqual([{ urls: STUN }]);
  });

  it("drops a TURN entry with an empty username or an empty password", () => {
    const servers = buildIceServers("eu-west-3", [
      { Uris: [TURN_TCP], Username: "", Password: "p" },
      { Uris: [TURN_TCP], Username: "u", Password: "" },
    ]);

    expect(servers).toEqual([{ urls: STUN }]);
  });

  it("drops a TURN entry that has no URI at all", () => {
    const servers = buildIceServers("eu-west-3", [{ Uris: [], Username: "u", Password: "p" }]);

    expect(servers).toEqual([{ urls: STUN }]);
  });

  it("drops a TURN entry with no URI list", () => {
    const servers = buildIceServers("eu-west-3", [{ Username: "u", Password: "p" }]);

    expect(servers).toEqual([{ urls: STUN }]);
  });

  it("refuses a URI whose region is not the region of the session", () => {
    const servers = buildIceServers("eu-west-1", [VALID_TURN]);

    expect(servers).toEqual([{ urls: stunUrl("eu-west-1") }]);
  });

  it("keeps a TURN URI with a port of up to five digits and no transport parameter", () => {
    const uri = "turn:turn-c3.kinesisvideo.eu-west-3.amazonaws.com:5349";
    const servers = buildIceServers("eu-west-3", [{ Uris: [uri], Username: "u", Password: "p" }]);

    expect(servers).toEqual([{ urls: STUN }, { urls: [uri], username: "u", credential: "p" }]);
  });

  it("drops a TURN URI with a port of more than five digits", () => {
    const uri = "turn:turn-c3.kinesisvideo.eu-west-3.amazonaws.com:123456";
    const servers = buildIceServers("eu-west-3", [{ Uris: [uri], Username: "u", Password: "p" }]);

    expect(servers).toEqual([{ urls: STUN }]);
  });
});
