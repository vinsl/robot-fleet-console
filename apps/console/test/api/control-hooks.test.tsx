/**
 * @vitest-environment jsdom
 *
 * Registry, demo state and demo switch of the control API, through the real query cache and HTTP client.
 */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useDemoState, useRobotRegistry, useSetDemo } from "../../src/api/control";
import { createControlHarness, json, SITE } from "../control/support";

const ROBOT_SUMMARY = {
  robotId: "sim-01",
  siteId: SITE,
  name: "Picker 01",
  type: "picker",
  designDate: "2026-01-15",
  simulated: true,
  status: "ACTIVE",
  createdAt: "2026-01-15T08:00:00.000Z",
};

afterEach(() => {
  cleanup();
});

describe("control queries", () => {
  it("lists the registry entries of the demo site", async () => {
    const harness = createControlHarness(() => json(200, { robots: [ROBOT_SUMMARY] }));
    const { result } = renderHook(() => useRobotRegistry(), { wrapper: harness.wrapper() });

    await waitFor(() => {
      expect(result.current.data?.[0]?.robotId).toBe("sim-01");
    });
    expect(harness.requests[0]?.path).toBe("/sites/paris-01/robots");
  });

  it("reads the demo state and replaces it with the answer of the switch", async () => {
    const harness = createControlHarness((request) =>
      request.method === "PUT"
        ? json(200, {
            enabled: true,
            changedBy: "11111111-2222-3333-4444-555555555555",
            changedAt: "2026-11-04T10:00:00.000Z",
          })
        : json(200, { enabled: false }),
    );
    const { result } = renderHook(() => ({ demo: useDemoState(), setDemo: useSetDemo() }), {
      wrapper: harness.wrapper(),
    });
    await waitFor(() => {
      expect(result.current.demo.data?.enabled).toBe(false);
    });

    await act(() => result.current.setDemo.mutateAsync(true));

    expect(harness.requests.at(-1)).toMatchObject({
      method: "PUT",
      path: "/sites/paris-01/demo",
      body: { enabled: true },
    });
    expect(harness.queryClient.getQueryData(["control-demo", SITE])).toMatchObject({
      enabled: true,
    });
  });
});
