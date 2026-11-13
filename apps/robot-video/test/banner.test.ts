import { describe, expect, it } from "vitest";
import en from "../src/i18n/en.json";
import { BANNER_VISUALS, bannerFor } from "../src/ui/banner";
import { IDLE_STATUS } from "./fixtures";

describe("bannerFor", () => {
  it("shows the e-stop as an alert with the octagon shape and its text", () => {
    const view = bannerFor({ ...IDLE_STATUS, state: "ESTOP", banner: "ESTOP" });

    expect(view?.kind).toBe("ESTOP");
    expect(view?.visual.role).toBe("alert");
    expect(view?.visual.shape).toBe("octagon");
    expect(view?.visual.textKey).toBe("banner.estop");
  });

  it("shows teleoperation as a status with the dashed circle and its text", () => {
    const view = bannerFor({ ...IDLE_STATUS, state: "TELEOP", banner: "TELEOP" });

    expect(view?.kind).toBe("TELEOP");
    expect(view?.visual.role).toBe("status");
    expect(view?.visual.shape).toBe("dashed-circle");
    expect(view?.visual.textKey).toBe("banner.teleop");
  });

  it("hides the banner when the status has none", () => {
    expect(bannerFor(IDLE_STATUS)).toBeNull();
  });

  it("hides the banner before the first status arrives", () => {
    expect(bannerFor(null)).toBeNull();
  });

  it("gives every banner a shape and a text, so that no state is carried by colour alone", () => {
    for (const visual of Object.values(BANNER_VISUALS)) {
      expect(visual.shape).not.toBe("");
      expect(en[visual.textKey]).toBeTruthy();
    }
  });
});
