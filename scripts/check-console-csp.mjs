#!/usr/bin/env node
/**
 * Content-Security-Policy safety check of the console build.
 *
 * The console is served under a strict CSP with no `unsafe-inline` and no third-party origin (ADR 0046). A
 * single inline script, inline handler, `javascript:` URL or external resource in the built `index.html` would
 * be blocked by every browser and would break the console silently, so the build fails first. The runtime
 * configuration is loaded with `fetch`, so the page needs no inline script.
 *
 * Usage: `node scripts/check-console-csp.mjs [path/to/index.html]`. Defaults to the console build output.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The built entry page of the console, relative to this script. */
const DEFAULT_PATH = fileURLToPath(new URL("../apps/console/dist/index.html", import.meta.url));

/** An opening `<script>` tag that has no `src` attribute: its body is inline code. */
const INLINE_SCRIPT = /<script\b(?![^>]*\ssrc\s*=)[^>]*>/gi;

/** A `<style>` element: inline CSS, which the policy forbids. */
const STYLE_ELEMENT = /<style\b/gi;

/** A `style` attribute on any element. */
const STYLE_ATTRIBUTE = /<[a-z][^>]*\sstyle\s*=/gi;

/** An inline event handler attribute such as `onclick=` on an element. */
const INLINE_HANDLER = /<[a-z][^>]*\son[a-z]+\s*=/gi;

/** A `javascript:` URL in a URL-bearing attribute. */
const JAVASCRIPT_URL = /<[a-z][^>]*\s(?:href|src|action|formaction)\s*=\s*["']?\s*javascript\s*:/gi;

/** A `src` or `href` that points to another origin: an absolute `http(s)` URL or a protocol-relative `//`. */
const EXTERNAL_RESOURCE = /<[a-z][^>]*\s(?:src|href)\s*=\s*["']?\s*(?:https?:|\/\/)/gi;

/**
 * Lists every construct that the console's strict CSP refuses in an HTML document.
 *
 * @param html - The document source.
 * @returns One readable line per violation; empty when the page is clean.
 */
export function findInlineViolations(html) {
  const checks = [
    [INLINE_SCRIPT, "inline <script>"],
    [STYLE_ELEMENT, "inline <style> element"],
    [STYLE_ATTRIBUTE, "style attribute"],
    [INLINE_HANDLER, "inline event handler"],
    [JAVASCRIPT_URL, "javascript: URL"],
    [EXTERNAL_RESOURCE, "external resource"],
  ];
  const violations = [];
  for (const [pattern, label] of checks) {
    for (const match of html.matchAll(pattern)) {
      violations.push(`${label} at offset ${String(match.index)}`);
    }
  }
  return violations;
}

/**
 * Runs the check on a file and reports the result on the console.
 *
 * @param target - Path of the HTML file.
 * @returns The process exit code: 0 when clean, 1 otherwise.
 */
export function runCheck(target) {
  let html;
  try {
    html = readFileSync(target, "utf8");
  } catch {
    console.error(`FAIL: cannot read ${target}; run the console build first`);
    return 1;
  }
  const violations = findInlineViolations(html);
  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(`FAIL: ${violation} in ${target}`);
    }
    return 1;
  }
  console.log(`check-console-csp: no inline script or style in ${target}`);
  return 0;
}

// Runs only when executed directly, so that the unit tests can import the functions without side effects.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runCheck(process.argv[2] ?? DEFAULT_PATH);
}
