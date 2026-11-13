import { describe, expect, it } from "vitest";
import viteConfig from "../../vite.config";

describe("vite config", () => {
  it("aliases the Node global used by amazon-cognito-identity-js to globalThis", () => {
    const resolved =
      typeof viteConfig === "function"
        ? viteConfig({ command: "build", mode: "production" })
        : viteConfig;
    expect(resolved).toMatchObject({ define: { global: "globalThis" } });
  });
});
