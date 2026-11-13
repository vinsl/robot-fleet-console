// ESLint flat configuration for the whole monorepo.
// Type-aware rules are on for TypeScript; JavaScript config files are linted without type information.
import { defineConfig, globalIgnores } from "eslint/config";
import js from "@eslint/js";
import globals from "globals";
import security from "eslint-plugin-security";
import tseslint from "typescript-eslint";

// Best effort: hex colours, colour functions and `color-mix()` anywhere in a string. Named colours
// ("red") are not detected; review catches them.
const COLOUR_LITERAL = String.raw`#[0-9a-fA-F]{3,8}\b|\b(rgb|hsl|oklch|oklab|lab|lch|hwb)a?\(|color-mix\(`;

export default defineConfig(
  // Generated code and the Python agent are owned by other toolchains and linted there.
  globalIgnores([
    "**/dist/**",
    "**/coverage/**",
    "packages/protocol/generated/**",
    "agent/**",
    // Byte-for-byte copy of a third-party release, pinned by SHA-256 (ADR 0026): not ours to lint.
    "apps/robot-video/public/vendor/**",
    // Same rule for the console's copy of the KVS bundle (ADR 0026, ADR 0067).
    "apps/console/public/vendor/**",
  ]),
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  security.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["apps/console/src/**", "apps/robot-video/src/**"],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    // Design rule (ADR 0004): colours come from `src/theme/tokens.ts`, never from component code.
    files: ["apps/console/src/**", "apps/console/test/**", "apps/robot-video/src/**"],
    ignores: ["apps/console/src/theme/**", "apps/console/test/theme/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: `Literal[value=/${COLOUR_LITERAL}/]`,
          message: "Hard-coded colour: use a token from src/theme/tokens.ts.",
        },
        {
          selector: `TemplateElement[value.raw=/${COLOUR_LITERAL}/]`,
          message: "Hard-coded colour: use a token from src/theme/tokens.ts.",
        },
      ],
    },
  },
  {
    // The domain is AWS-free behind ports: an SDK or a Powertools import there would couple the business
    // rules to one runtime, and the tests would need the network to exercise them. The domain never
    // imports the adapters either (the dependency points inwards), so the adapters can be replaced in tests.
    files: ["services/api/src/domain/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@aws-sdk/*", "@aws-lambda-powertools/*"],
              message: "Domain code depends on ports only; put the SDK call in an adapter.",
            },
            {
              group: ["**/adapters/**", "../adapters/**"],
              message:
                "Domain code must not import adapters; depend on a port in domain/ports.ts instead.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["**/*.{js,mjs}"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    // Paths in these build scripts come from import.meta.url constants, and the tests of the build
    // script use folders made by mkdtemp, never external input, so the non-literal filename warning
    // is a false positive here. The protocol fixture tests read the fixed fixtures folder the same way.
    files: [
      "packages/protocol/scripts/**",
      "packages/protocol/test/fixtures.test.ts",
      "services/api/test/handlers/robots.test.ts",
      "services/api/scripts/**",
      "services/api/test/scripts/**",
      "apps/robot-video/test/vendor.test.ts",
      "apps/console/test/video/vendor.test.ts",
      "apps/robot-video/test/built-page.test.ts",
      "apps/robot-video/test/parity.test.ts",
      "apps/robot-video/test/source-scan.test.ts",
      "apps/robot-video/test/styles.test.ts",
      "apps/robot-video/scripts/**",
      "scripts/check-console-csp.mjs",
      "scripts/check-console-fixtures.mjs",
      "scripts/check-console-csp.test.mjs",
    ],
    rules: {
      "security/detect-non-literal-fs-filename": "off",
    },
  },
);
