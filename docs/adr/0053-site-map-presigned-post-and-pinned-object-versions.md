# ADR 0053 — Site maps: presigned POST uploads and pinned S3 object versions

- Status: accepted
- Date: 2026-11-03
- Requirements: FR-SITE-2
- Threats: T6 (malicious map file), T10 (map read by another site), T43 (map swapped after validation), T44
  (activation of an unchecked version); accepted risks R66 to R69
- Implemented in `services/api/src/domain/site/` (create-map, validate-map, get-map-url, activate-map),
  `services/api/src/adapters/s3-site-maps.ts` and `services/api/src/adapters/dynamodb-site.ts` (M7).

## Context

An Admin uploads a site map as GeoJSON, at most 2 MB (`SITE_MAP_MAX_BYTES`). The file must be checked before the
fleet uses it, and the file that was checked must be the file the operator later downloads. The bucket is versioned,
so a second upload to the same key creates a new object version; without a pin, a validated map could be replaced
between the check and the activation. The client must not choose object keys, and the API Gateway body limit is not
a reason to pass file bytes through a Lambda that does not need them.

## Decision

- `POST /sites/{siteId}/maps` reserves a version slot in DynamoDB with status `PENDING` and a one-day TTL, and builds
  the object key on the server (`sites/{siteId}/maps/{version:000000}.geojson`). The presigned POST fixes the key,
  the size range (1 to 2,000,000 bytes), the `application/geo+json` content type and a 300 s expiry. The browser
  uploads straight to S3.
- `POST .../validate` reads the object at the version that S3 reports on the head request, parses it against the
  protocol schema, and computes its SHA-256. It then moves the slot to `VALID` with the object version id and the
  digest, in a write conditioned on `status = PENDING`, so the pin applies once. Any refusal leaves the slot `PENDING`.
- `GET .../maps/{version}` presigns a download of the pinned object version, and only for a `VALID` slot.
- `POST .../activate` runs a `TransactWriteItems`: a `ConditionCheck` that the version is `VALID`, and the update of
  the site's active version. The state is checked again inside the write, not only at the read.

## Alternatives considered

| Option                                             | Pros                                                    | Cons                                                                                                                                                                                       | Why not                                                                                              |
| -------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Lambda proxy upload (bytes through the API)        | One call, the server sees the bytes before storing them | Bytes cross API Gateway and a Lambda for up to 2 MB; memory and duration cost; more to test for abuse                                                                                      | The Lambda would only relay bytes that S3 can receive directly under a signed policy                 |
| S3 event trigger that validates each new object    | No call from the console to validate                    | Asynchronous, so the console cannot tell when the check ended; one event per object, not per version reservation; retries and duplicate events to handle; a second Lambda and its IAM role | More moving parts for the same guarantee; the synchronous validate call keeps the state in one place |
| Validate the latest object at activation, unpinned | Simplest write                                          | A re-upload after validation changes the file that is activated (time of check to time of use)                                                                                             | Breaks the guarantee that the activated file is the validated file                                   |

## Consequences

- Easier: the Lambda handles file bytes only during validation, and the object key is never client input.
- Easier: the activated file is the validated file, whatever is uploaded to the same key later.
- Harder: the operator must call validate after the upload; a refused file must be uploaded again to a new slot
  or the same slot while it is `PENDING`.
- Watch: a presigned POST cannot be revoked. For 300 s after validation, its form can still write to the same key,
  which creates an object version that no slot pins (R66). The bucket's 30-day noncurrent-version lifecycle can
  delete a pinned version once a newer version exists at the same key. The follow-up in the infrastructure PR is to
  exclude pinned versions from expiry or raise the retention (R67).
- Watch: the uploaded object of a `PENDING` slot that never validates stays in the bucket, because the lifecycle
  rule expires noncurrent versions only (R69). An
  Admin can reserve slots up to the `MAP_MAX_VERSIONS` cap of 200; the API throttle is the only limit on that (R68).
- Security: the bucket is private and versioned, uploads are limited by the policy, and downloads are presigned for
  300 s on a pinned version. The Lambda role of the site handler must be pinned by a Terraform test before it is
  deployed (pending infrastructure PR).
- Cost: presigned requests and two small DynamoDB writes per upload; storage is bounded by the 200-version cap.
