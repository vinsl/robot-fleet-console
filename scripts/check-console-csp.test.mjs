/**
 * Unit tests of the console CSP check: clean pages pass, each forbidden construct fails.
 * Run by `make check-ts` with `node --test`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { findInlineViolations } from "./check-console-csp.mjs";

/** Shape of the built page: a module script and a stylesheet link, both same-origin. */
const CLEAN_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <script type="module" crossorigin src="/assets/index-abc.js"></script>
    <link rel="stylesheet" crossorigin href="/assets/index-def.css">
  </head>
  <body>
    <div id="root"></div>
    <a href="/alerts">Alerts</a>
  </body>
</html>`;

describe("findInlineViolations", () => {
  it("accepts the built page shape", () => {
    assert.deepEqual(findInlineViolations(CLEAN_PAGE), []);
  });

  const forbidden = [
    ["inline script", "<script>alert(1)</script>"],
    ["inline script with a type", '<script type="text/javascript">x()</script>'],
    ["inline style element", "<style>p{}</style>"],
    ["style attribute", '<div style="color:red"></div>'],
    ["inline click handler", '<button onclick="go()">x</button>'],
    ["inline load handler", '<img src="/a.png" onerror="x()">'],
    ["javascript href", '<a href="javascript:alert(1)">x</a>'],
    ["javascript src", '<iframe src="javascript:x()"></iframe>'],
    [
      "absolute https script",
      '<script type="module" src="https://cdn.example.test/x.js"></script>',
    ],
    ["protocol-relative stylesheet", '<link rel="stylesheet" href="//cdn.example.test/x.css">'],
    ["absolute http link", '<a href="http://example.test/">x</a>'],
  ];
  for (const [name, fragment] of forbidden) {
    it(`rejects ${name}`, () => {
      const violations = findInlineViolations(`<html><body>${fragment}</body></html>`);
      assert.ok(violations.length > 0, `expected a violation for ${fragment}`);
    });
  }

  it("does not flag the word on or style in text", () => {
    const html = "<p>Only one one, style guide and on-call rota.</p>";
    assert.deepEqual(findInlineViolations(html), []);
  });
});

describe("fixture marker", () => {
  it("matches the marker of the end-to-end fake, so the production guard finds it", () => {
    const fake = readFileSync(
      fileURLToPath(new URL("../apps/console/src/auth/fake-auth-client.ts", import.meta.url)),
      "utf8",
    );
    const marker = /export const FIXTURE_MARKER = "([^"]+)"/.exec(fake)?.[1];
    const guard = readFileSync(
      fileURLToPath(new URL("./check-console-fixtures.mjs", import.meta.url)),
      "utf8",
    );
    assert.ok(marker !== undefined, "FIXTURE_MARKER is declared");
    assert.ok(guard.includes(`"${marker}"`), "the guard uses the same marker");
  });
});
