# Security policy

Fleet Console is a demonstration project. It is built to production security standards and its
threat model is public in this repository: see `docs/security/THREAT_MODEL.md`,
`docs/security/CHECKLIST.md` and `docs/security/CI_CD.md`.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub private vulnerability reporting on this repository
(Security tab → "Report a vulnerability"), or contact the maintainer directly. You will get an answer
within 72 hours. Please include the affected component, reproduction steps and the impact you expect.

## Scope

In scope: the console, the HTTP and WebSocket APIs, the robot agent, the Terraform code, the CI/CD
workflows. Out of scope: denial-of-service testing against the live demo, social engineering, and
findings in third-party services (AWS, GitHub) themselves.

## Supported versions

Only the `main` branch is maintained.
