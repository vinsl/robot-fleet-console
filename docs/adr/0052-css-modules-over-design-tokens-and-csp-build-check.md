# ADR 0052 — Styling: CSS modules over design tokens, and a build check for the strict CSP

- Status: accepted
- Date: 2026-11-03
- Requirements: SEC-WEB-1, NFR-MAINT-1
- Threats: T21 (clickjacking or XSS on the console), R53 (wildcard `connect-src`)
- Implemented in PR-5 (console shell): `apps/console/src/**/*.module.css`, `apps/console/src/theme/tokens.css`,
  `scripts/check-console-csp.mjs`

## Context

The design is locked (`docs/design/DESIGN.md`): every colour, font, size, radius and duration comes from the tokens in
`apps/console/src/theme/`. The CSP forbids inline styles and `unsafe-inline` (`style-src 'self'`, ADR 0046). A
runtime CSS-in-JS library writes `<style>` elements into the page, so it cannot run under this policy without a
relaxed rule. The README and `docs/SPEC.md` still name Tailwind CSS and shadcn/ui; the console does not use them.

## Decision

- Each component has a CSS module (`*.module.css`) next to it. The modules read the custom properties of
  `theme/tokens.css` and nothing else. A value that is not a token is a review finding.
- Vite emits each stylesheet as a file linked from `index.html` (`build.cssCodeSplit: true`). No style is inlined.
- `scripts/check-console-csp.mjs` runs on the built `index.html` and fails on an inline `<script>`, a `<style>` element,
  a `style` attribute, an inline event handler, a `javascript:` URL or an external `src` or `href`. It runs in
  `make check-ts` after the production build. Its unit tests are in `scripts/check-console-csp.test.mjs`.

## Alternatives considered

| Option                              | Pros                                 | Cons                                                                                         | Why not                                                                  |
| ----------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Tailwind CSS with shadcn/ui         | Fast to write; a large component set | A second naming layer over the locked tokens; one more dependency and build step to maintain | The tokens are already CSS variables; the design needs no framework grid |
| CSS-in-JS (runtime `<style>`)       | Co-located styles                    | Needs `unsafe-inline` or a nonce per render under the strict CSP                             | Breaks SEC-WEB-1                                                         |
| Plain global CSS                    | No build step                        | Class names collide across screens                                                           | Modules scope the names at no cost                                       |
| Only the CSP header, no build check | Less code                            | An inline construct would break the page at run time, unnoticed in CI                        | The build fails first, with a readable message                           |

## Consequences

- The strict CSP can stay as it is: `style-src 'self'` with no `unsafe-inline`.
- Token discipline is by review and by the design tests (`apps/console/test/theme/theme-contract.test.ts`). No stylelint
  rule enforces it yet.
- The check reads only `index.html`. A script that inserts a `<style>` element at run time is not seen by it, and the
  CSP blocks it in the browser instead.
- `DESIGN.md`, `SPEC.md` and the README tech stack name Tailwind and shadcn/ui. Those documents are out of date on this
  point; the locked design text is not changed here (a visual change needs its own ADR).
