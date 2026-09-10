# ADR-009: ALB Cognito Auth Instead of CloudFront + Lambda@Edge / CloudFront 대신 ALB Cognito 인증

## Status: Accepted / 상태: 승인됨

## Context / 컨텍스트

The original architecture put CloudFront in front of the ALB and handled authentication with a
Lambda@Edge function (Python 3.12, us-east-1) that validated Cognito JWTs on the viewer request.

기존 아키텍처는 ALB 앞에 CloudFront를 두고, viewer request에서 Cognito JWT를 검증하는
Lambda@Edge(Python 3.12, us-east-1)로 인증을 처리했다.

When deploying to the musinsa `dev1` account (003399921004), `cdk deploy` failed:

```
User: arn:aws:sts::003399921004:assumed-role/cdk-hnb659fds-cfn-exec-role-.../AWSCloudFormation
is not authorized to perform: cloudfront:CreateDistribution
with an explicit deny in a service control policy
```

The organization's SCP (`p-j4rrv7bk`) denies CloudFront distribution creation. SCPs are evaluated
above account-level IAM, so this cannot be worked around with permissions — even AdministratorAccess
is blocked. CloudFront is off the table in this account.

조직 SCP가 CloudFront 배포 생성을 명시적으로 거부한다. SCP는 계정 IAM보다 상위에서 평가되므로
AdministratorAccess로도 우회 불가하다.

## Decision / 결정

Remove CloudFront entirely. Terminate TLS at the ALB and use the ALB's built-in
`authenticate-cognito` listener action instead of Lambda@Edge.

CloudFront를 제거하고 ALB에서 TLS를 종료한다. Lambda@Edge 대신 ALB 내장
`authenticate-cognito` 리스너 액션으로 인증한다.

```
Route 53 (awsops.dev1.musinsa.io)
  └─ ALB :443  (ACM cert, ap-northeast-2 — regional, not us-east-1)
       ├─ authenticate-cognito  ← auth happens here
       ├─ default        → Dashboard  (EC2 :3000)
       ├─ /vscode*       → nginx      (EC2 :8889 → code-server :8888)
       └─ /awsops*       → 301 redirect to / (legacy path)
```

### Consequences / 결과

| Area | Before | After |
|---|---|---|
| TLS cert | ACM in **us-east-1** (CloudFront requirement) | ACM in **ap-northeast-2** (same region as ALB) |
| Auth mechanism | Lambda@Edge validates JWT | ALB `authenticate-cognito` action |
| User identity in app | `awsops_token` cookie | `x-amzn-oidc-data` header (`src/lib/auth-utils.ts` reads both) |
| Cognito callback | `/awsops/_callback` (custom) | `/oauth2/idpresponse` (**fixed** — ALB requires this path) |
| CDN caching | CloudFront edge cache | none (internal tool, no benefit lost) |
| Setup step 8 | `08-setup-cloudfront-auth.sh` | deprecated no-op; auth attached in step 5 |

### Trade-offs / 트레이드오프

- **Auth session is owned by the ALB.** Logging out means expiring the ALB's
  `AWSELBAuthSessionCookie-*` cookies *and* ending the Cognito session — clearing the app cookie
  alone does nothing. See `src/app/api/auth/route.ts`.
- **A custom domain is now mandatory.** The ALB needs an HTTPS listener with a real certificate,
  so `-c customDomain=...` is required (the stack throws without it). Previously the CloudFront
  default domain was usable.
- **`authenticate-cognito` is not managed by CDK here.** Step 5 attaches it via CLI after deploy,
  so a `cdk deploy` that rewrites the 443 listener drops it and it must be re-attached. See the
  deployment runbook.

## Alternatives Considered / 검토한 대안

1. **Request an SCP exception for CloudFront** — rejected for this PoC: turnaround time is
   uncertain and the org appears to block CloudFront deliberately (central CDN governance).
2. **Keep Lambda@Edge, drop CloudFront** — not possible; Lambda@Edge only runs on CloudFront.
3. **Self-hosted auth proxy (oauth2-proxy) on EC2** — more moving parts than the ALB's native
   action, with no benefit for this use case.

## Postscript: the plick account (2026-09-10) / 후기: plick 계정

This ADR was written for the musinsa `dev1` account, where an SCP denied CloudFront. The plick
account (`815090125359`) does **not** block CloudFront — `cloudfront:ListDistributions` succeeds
and five distributions already exist there. The decision still stands, for different reasons:

이 ADR은 CloudFront가 SCP로 막힌 musinsa `dev1` 계정을 전제로 쓰였다. plick 계정
(`815090125359`)은 CloudFront를 **막지 않는다** — 조회가 되고 배포도 5개 존재한다.
그래도 결정은 유지한다. 이유가 다를 뿐이다.

- The ALB action is one listener rule, not a CloudFront distribution plus a Lambda@Edge function
  replicated to every edge location — less to build, less to keep in sync.
- Lambda@Edge only deploys from `us-east-1`, adding a second region to the deployment story.
- The dashboard is internal and low-traffic; there is nothing for a CDN to accelerate.

What differs here: auth must be attached to **both** the default action (the dashboard, at the
root) and the `/vscode*` rule. Upstream has these reversed, so a script that hardcodes the rule
priority leaves code-server exposed. `05-setup-cognito.sh` now matches on the path pattern.

이 계정에서 다른 점: 인증을 **기본 액션(루트의 대시보드)과 `/vscode*` 규칙 양쪽**에 붙여야 한다.
업스트림은 이 둘이 반대라, 규칙 우선순위를 하드코딩한 스크립트는 code-server를 무인증으로 남긴다.
`05-setup-cognito.sh`는 이제 path-pattern으로 찾는다.

The SCP that does bite this account is a different one: `p-5soyo0ar` denies `ce:GetCostAndUsage`,
so Cost Explorer is unavailable. See `docs/runbooks/plick-deployment.md`.
