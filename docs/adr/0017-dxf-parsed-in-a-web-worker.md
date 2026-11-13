# ADR 0017 — Site maps: DXF parsed in the browser, in a Web Worker, with a bounded parser

- Status: accepted
- Date: 2026-11-03
- Requirements: FR-SITE-2, SPEC §4.5, SEC-WEB-1
- Threats: T6 (malicious DXF), B8 (browser ↔ DXF file from the internet)
- Implemented in M7 (console): `apps/console/src/site/dxf/` (`types.ts` for `DXF_LIMITS`, `parse-dxf.ts`,
  `dxf.worker.ts`, `worker-client.ts`)

## Context

An Admin imports a DXF drawing of a warehouse. The file comes from a customer or from the internet, so it is untrusted
input, and it can be large (the limit is 20 MB) or built to make a parser loop or allocate without end. SPEC §4.5 says the
DXF is parsed in the browser, never leaves it, and only the GeoJSON derived from it is stored. The parse must not freeze
the page, and the console must not depend on a library whose licence and input handling this project has not reviewed.

## Decision

- The DXF is parsed in a module Web Worker (`dxf.worker.ts`), not on the main thread. The worker replies with the
  flattened document or with a refusal code only; it never returns the file text and never sends an error message,
  because a message can echo part of the file.
- The parser is a small project module that reads the subset the import needs: LINE, LWPOLYLINE, POLYLINE, CIRCLE,
  ARC, and INSERT (one level, nested inserts are counted as ignored). Every bound is a constant in `DXF_LIMITS`:
  20 MB of text, 2 000 000 group pairs, 200 000 entities, 300 000 entities after block expansion, 2 000 000 expanded
  vertices, 500 layers, and 50 000 vertices per polyline.
- The client refuses a file that is not named `.dxf` or is above 20 MB before reading it. A timer of 15 s bounds the
  wait. The worker is terminated after every outcome (reply, refusal, error or timeout), so a stuck parse cannot keep a
  thread busy.
- A worker that cannot start or fails, including an out-of-memory failure, is reported as `too-complex`.

## Alternatives considered

| Option                          | Pros                                      | Cons                                                                                                                                                            | Why not                                                                                                                        |
| ------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| npm `dxf-parser`                | Existing parser, covers more entity types | Its input handling is not bounded by this project's limits (entities, vertices, block expansion), and its licence and maintenance need a review at every update | SPEC §4.5 allows it only after a licence check, and the bounds are the security control, so they must be ours to read and test |
| Server-side parsing in a Lambda | The browser never runs the parser         | Lambda cost per upload; a 20 MB upload to the API path; a parser bug runs in the account; more attack surface on the API (SEC-API-1 checks in one more handler) | Breaks "the DXF never leaves the browser" (SPEC §4.5) and adds cost for a one-off Admin action                                 |
| Parsing on the main thread      | No worker, no build change                | A large or hostile file freezes the page; the 15 s bound would need to be enforced by the page itself, which cannot interrupt a synchronous loop                | The worker is what makes the timeout real                                                                                      |

## Consequences

- The parser is ours: about 1 000 lines to read and test. The hostile-input tests (`parse-dxf.test.ts`, `worker.test.ts`)
  are the evidence for the limits, and a new entity type needs a new test and a note in SPEC §4.5.
- The DXF never reaches AWS. Only the GeoJSON that the editor builds from the parsed drawing is uploaded.
- A 20 MB file that is inside every limit can still keep the worker busy for up to the 15 s timeout. The page stays
  responsive; the operator waits. Accepted in THREAT_MODEL R67.
- The worker is a separate script of the same origin. The CSP allows it with `worker-src 'self' blob:` (ADR 0046), and no
  other CSP change was needed.
- Cost: none. The work runs on the operator's machine.
