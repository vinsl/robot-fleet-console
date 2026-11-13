# ADR 0008 — Serverless without VPC (no NAT Gateway)

- Status: accepted
- Date: 2026-10-31
- Requirements: NFR-COST-1, NFR-COST-2, SEC-IAM-1, SEC-API-1

## Context

SPEC §3 states the shape: no VPC, so no NAT Gateway. Lambda functions inside a VPC need a NAT Gateway to
reach public AWS endpoints such as IoT Core, Kinesis Video Streams, DynamoDB and SQS. A NAT Gateway costs
about 30 € per month before data processing, which is close to the whole budget of the demo (NFR-COST-1).
NFR-COST-2 requires an idle cost close to zero, with no VPC, NAT, ALB or EC2.

## Decision

No Lambda function runs inside a VPC, and the stack has no NAT Gateway, load balancer, EC2 instance or
RDS and ElastiCache cluster. Each function reaches the AWS public endpoints over TLS. Access is then
controlled by identity, not by network position:

- AWS API calls are signed with the function's IAM role, limited by its own policy and by the workload
  permission boundary (ADR 0020).
- Robot connections use X.509 client certificates (IoT Core, ADR 0010).
- Console requests carry a Cognito JWT, checked by the API Gateway authorizer (SEC-API-1).

## Alternatives considered

| Option                            | Pros                                                         | Cons                                                                                           | Why not                                                                 |
| --------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| VPC with NAT Gateway              | Fixed egress address; network controls                       | About 30 € per month before data charges, against a 0 € target                                 | Breaks NFR-COST-1 and NFR-COST-2                                        |
| VPC with interface endpoints      | No internet egress for the listed services; network controls | Each endpoint is billed per hour and per zone; the set of services is large                    | The cost adds up across services and the controls duplicate IAM         |
| No VPC, public endpoints (chosen) | No fixed network cost; scales to zero                        | No fixed egress address; a compromised function can reach any public endpoint it is allowed to | Accepted: the limit is the IAM role of each function (THREAT_MODEL T16) |

## Consequences

- Lambda egress addresses change; nothing in the design depends on a fixed source address.
- Network position is no protection, so every resource policy must name its principals and actions. A
  broad IAM grant becomes the only control on data access, which is why the roles are reviewed (ADR 0020).
- DynamoDB, S3 and SQS are reached through their public endpoints. Gateway endpoints, which are free, only
  serve resources inside a VPC, so they do not apply here.
- Adding a service that only accepts VPC traffic would require a new ADR and the cost of a NAT Gateway or
  endpoints.
- Cost: no fixed network charge. The bill is pay-per-request, and the budgets in ADR 0005 watch it.
