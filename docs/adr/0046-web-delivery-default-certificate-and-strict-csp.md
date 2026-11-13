# ADR 0046 — Web delivery: private bucket behind CloudFront, default certificate and strict CSP

- Status: accepted
- Date: 2026-11-03
- Requirements: FR-AUTH-1, SEC-WEB-1, SEC-WEB-2, SEC-API-4, SEC-IAM-1, SPEC section 8 (console and logs buckets)
- Threats: T21 (clickjacking and XSS on the console), T3 (token theft after XSS), T8 (video), T9 (secrets in logs),
  T35 (console build read outside CloudFront or over an old TLS version);
  accepted risks R52 (default certificate, TLSv1 minimum), R53 (region-wide CSP hosts), R54 (no viewer logs),
  R55 (CI deploy role can change the console bucket)
- Implemented in `infra/modules/web` and `infra/envs/demo/web.tf` (M6 PR-3). The console build is published by
  `make publish-console` (M6 PR-6).

## Context

The console is a static single page application that talks to the HTTP API, the WebSocket, Cognito and Kinesis Video.
Its bucket must stay private, the page must not be framed, and a script injected into the page must not run. The
demo has no domain of its own, so there is no ACM certificate to attach. The API must allow the console origin in its
CORS configuration (SEC-API-4), so the CSP cannot name a CloudFront origin that the API configuration also names
without a dependency cycle between the two stacks.

## Decision

- The build sits in a private bucket (Block Public Access, ACLs disabled with `BucketOwnerEnforced`, SSE-S3, TLS 1.2
  or later). Only the distribution reads it, through an origin access control with sigv4, and the bucket policy names the
  distribution ARN.
- The distribution uses the CloudFront default certificate. Its minimum protocol is TLSv1, which AWS forces for the
  default certificate. This is accepted risk R52: no custom domain exists, and an ACM certificate needs one. Browsers
  still negotiate TLS 1.2 or 1.3 with CloudFront in practice.
- The response headers policy sets a strict CSP: `default-src 'none'`, `script-src 'self'`, `style-src 'self'`, no
  `unsafe-inline` and no `unsafe-eval`, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'none'`,
  `form-action 'none'`. `connect-src` names the API, WebSocket, Cognito and Kinesis Video hosts of the region
  (wildcard subdomains, region taken from the variable), so the API does not need the CloudFront origin in its
  configuration (R53). The build must not need inline code: if it does, the build fails rather than the CSP loosening.
- Also set: HSTS for two years with `includeSubDomains` and without `preload` (the host is a `cloudfront.net` name that
  the demo does not own, so there is nothing to preload), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, `Permissions-Policy` with the camera, microphone, geolocation and payment off,
  `Cross-Origin-Opener-Policy` and `Cross-Origin-Resource-Policy` at `same-origin`.
- The distribution serves `index.html` at the root, redirects HTTP to HTTPS, accepts GET and HEAD only, does not cache
  `index.html` or `config.json` (CachingDisabled), caches `/assets/*` (CachingOptimized, the names carry a content hash),
  and turns 403 and 404 into `index.html` with status 200, uncached, so the router decides what to show.
- Access logs: the S3 server access logs of the console bucket go to a logs bucket with a 30-day lifecycle, under the
  `s3/` prefix. The bucket policy admits the S3 log delivery service only for this account and the console bucket.
  CloudFront logging is not enabled (see Alternatives).
- No WAF and no geo restriction (SPEC section 11, R1). The distribution is in the price class that covers Europe and
  North America.
- The bucket names carry the `bucket_suffix` of the stack, not the account id, so no URL of the console shows the
  account. The design named them with the account id; the suffix keeps the same uniqueness without that exposure.
- The publish script runs with the operator's SSO session. CI gets no upload statement beyond the `mfc-demo-*` grant it
  already has, and the bucket policy does not name the deploy role. That grant is `s3:*` on `mfc-demo-*`
  (`S3DemoBuckets` in `infra/bootstrap/policies.tf`, R18), so the deploy role can change the console bucket and its
  policy. The bucket policy not naming the deploy role is not a control. This is accepted residual R55.

## Alternatives considered

| Option                                        | Pros                                         | Cons                                                                                                 | Why not                                                                            |
| --------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Custom domain with an ACM certificate         | TLS 1.2 minimum, a memorable host            | A domain the owner must own and delegate; ACM in us-east-1 for CloudFront                            | No domain in the demo budget; an ACM certificate is a second region to manage      |
| CloudFront classic logging to the logs bucket | Viewer request logs                          | Needs object ACLs (`BucketOwnerPreferred` and the log delivery grant), which the bucket rules forbid | Conflicts with `BucketOwnerEnforced` on the logs bucket                            |
| CloudFront standard logging v2                | No ACL, viewer logs                          | Delivery source must be created in us-east-1, a second provider alias for one resource               | Cost and a second region for a demo log; S3 access logs cover the origin fetches   |
| API behind the CloudFront origin (`/api/*`)   | No CORS, one origin                          | Adds a behaviour to the API origin and a cycle with the API stack; the spec asks for CORS            | CORS to the console origin only is the spec (SEC-API-4); no cycle                  |
| CSP `connect-src` naming the exact API ID     | Narrowest host list                          | The API id is created after the distribution, so the CSP would need a second apply                   | Region-wide wildcard, accepted as R53; the API still checks the token on each call |
| CSP with `unsafe-inline` for styles           | Allows CSS-in-JS and inline style attributes | Weakens the CSP that protects the token in memory (ADR 0045)                                         | The build uses external CSS; the CSP stays strict                                  |

## Consequences

- A stolen page cannot run inline script or `eval`, cannot be framed, and cannot send the token to a host outside the
  region's API, WebSocket, Cognito and Kinesis Video names. The residual is R53: a page that could be injected could
  still call another API Gateway in the same region.
- The default certificate means the TLS minimum is TLSv1. The checklist line V9 (TLS 1.2 or later) is therefore not met
  by the transport policy and is recorded as R52. A custom domain would close it.
- Viewer request logs are absent (R54). Origin fetches are logged by S3 access logging; a viewer-side question can only be
  answered with the access logs of the bucket. Revisit if an incident needs viewer logs.
- Every build change goes through `make publish-console`: the bucket is replaced as a whole and `index.html` and
  `config.json` are invalidated. A bad build is rolled back by publishing an earlier commit.
- The 403 and 404 rewrite also covers `/assets/*`, so a missing hashed asset returns `index.html` with status 200, not
  a 404. `publish-console` must upload the assets before it invalidates `/index.html`, so no page refers to an asset
  that is not in the bucket yet (CHECKLIST, Web delivery).
- The CSP must be updated with the region, and with any new host of the console (for example a new Kinesis Video
  endpoint). Forgetting one shows as a blocked request in the browser console, not as silent failure.
- The web module's Terraform tests assert the headers, the origin access control and the bucket policies (except the
  CloudFront read statement, which names the distribution ARN and is reviewed in the plan comment, as R50).
- Cost: CloudFront and S3 stay within the free tier at demo scale, and no WAF fee applies (SPEC section 11).
