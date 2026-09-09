# Runbook: musinsa dev1 배포 / musinsa dev1 Deployment

이 계정(003399921004, ap-northeast-2)에 배포할 때만 해당하는 사항. 일반 설치 절차는
`docs/INSTALL_GUIDE.md`를 따르고, 아래는 **이 환경에서 다르게 동작하거나 사람이 개입해야 하는 지점**만 정리한다.

Environment-specific notes for the musinsa `dev1` account. Follow `docs/INSTALL_GUIDE.md` for the
general flow; this file only covers what differs here or needs manual intervention.

## 현재 구성 / Current setup

| 항목 | 값 |
|---|---|
| 계정 / Account | `003399921004` (musinsa_dev1), ap-northeast-2 |
| 대시보드 / Dashboard | `https://musinsight.dev1.musinsa.io/` |
| VSCode | `https://musinsight.dev1.musinsa.io/vscode` |
| 인증 / Auth | Cognito → ALB `authenticate-cognito` (ADR-009) |
| AI 모델 / Model | `global.anthropic.claude-opus-4-8` (단일) |
| CMDB 태그 | `Realm=awsops`, `ServiceDomain=aws`, `ServiceComponent=awsops-poc`, `Environment=sandbox` |

## 제약 / Constraints

- **CloudFront 사용 불가.** 조직 SCP(`p-j4rrv7bk`)가 `cloudfront:CreateDistribution`을 거부한다.
  AdministratorAccess로도 우회 불가 — ADR-009 참조.
- **`us.*` Bedrock 추론 프로필 없음.** 서울 리전에는 `global.*`과 `apac.*`만 존재한다.
  `agent/agent.py`가 `us.*`를 쓰면 런타임에 실패한다.
- **AgentCore Memory API 미지원 리전.** Step 6f는 자동으로 로컬 파일 폴백(`data/memory/`)으로 넘어간다. 정상이다.

## 재배포 시 주의사항 / Redeploy gotchas

### 1. Cognito 인증 액션은 CDK가 관리하지 않는다

`cdk deploy`가 443 리스너를 다시 쓰면(인증서 교체, 규칙 변경 등) 기본 액션에 붙여둔
`authenticate-cognito`가 **사라진다.** 배포 후 반드시 확인하고, 없으면 다시 붙인다.

```bash
L=$(aws cloudformation describe-stacks --stack-name AwsopsStack --region ap-northeast-2 \
     --query "Stacks[0].Outputs[?OutputKey=='HttpsListenerArn'].OutputValue|[0]" --output text)

# 확인 — authenticate-cognito 가 있어야 정상
aws elbv2 describe-listeners --listener-arns $L --region ap-northeast-2 \
  --query 'Listeners[0].DefaultActions[].Type'

# 없으면 재부착
bash scripts/05-setup-cognito.sh   # User Pool이 이미 있으면 해당 부분만 건너뛴다
```

`/vscode` 규칙(priority 10)에도 같은 인증 액션이 필요하다.

### 2. ALB 규칙 우선순위는 10 / 20을 쓴다

우선순위 1, 2를 쓰면 스택 업데이트 중 기존 규칙과 충돌해
`Priority '1' is currently in use`로 롤백된다. CDK가 새 규칙을 만든 뒤 옛 규칙을 지우기 때문.

### 3. Step 6(AgentCore)에는 설치용 권한이 임시로 필요하다

EC2 역할(`awsops-ec2-role`)은 평소 **호출 권한만**(`AgentCoreRuntimeAccess`) 갖는다.
Step 6을 (재)실행할 때는 로컬에서 설치용 인라인 정책을 붙였다가 끝나고 되돌린다.

```bash
# 설치 전 — 임시 권한 부여
aws iam put-role-policy --role-name awsops-ec2-role --policy-name TempAgentCoreSetup \
  --policy-document '{"Version":"2012-10-17","Statement":[
    {"Effect":"Allow","Action":["iam:CreateRole","iam:AttachRolePolicy","iam:PutRolePolicy",
      "iam:TagRole","iam:PassRole","iam:CreateServiceLinkedRole"],"Resource":"*"},
    {"Effect":"Allow","Action":["ecr:*","lambda:*","bedrock-agentcore:*",
      "ec2:CreateSecurityGroup","ec2:AuthorizeSecurityGroupIngress","ec2:CreateTags"],"Resource":"*"}]}'

# ... EC2에서 scripts/06-setup-agentcore.sh 실행 ...

# 설치 후 — 회수
aws iam delete-role-policy --role-name awsops-ec2-role --policy-name TempAgentCoreSetup
```

`iam:CreateServiceLinkedRole`이 빠지면 `CreateAgentRuntime`이
"Failed creating service linked role"로 실패한다.

### 4. Runtime 생성 직후 엔드포인트 생성은 실패할 수 있다

`Agent version 1 must be in READY status. Current status: CREATING` — 초기화 대기 문제다.
6a를 통째로 재실행하면 Runtime이 중복 생성되므로, READY를 기다렸다가 엔드포인트만 만든다.

```bash
RT_ID=<runtime id>
aws bedrock-agentcore-control get-agent-runtime --agent-runtime-id $RT_ID \
  --region ap-northeast-2 --query status --output text   # READY 대기
aws bedrock-agentcore-control create-agent-runtime-endpoint \
  --agent-runtime-id $RT_ID --name awsops_endpoint \
  --tags Realm=awsops,ServiceDomain=aws,ServiceComponent=awsops-poc,Environment=sandbox \
  --region ap-northeast-2
```

### 5. 재빌드 후에는 서비스 전체를 다시 올린다

`03-build-deploy.sh`만 실행하면 Steampipe가 내려간 채로 남아 **대시보드의 모든 수치가 0**으로 보인다.
증상이 보이면 `steampipe service status`부터 확인할 것.

```bash
bash scripts/03-build-deploy.sh
bash scripts/09-start-all.sh      # Steampipe 포함 전체 기동
```

### 6. EC2를 재생성하면 Step 5~6을 다시 해야 한다

nginx(`/vscode` 프록시)는 user-data에 코드화돼 있어 자동 설치된다. 하지만 Cognito(Step 5)와
AgentCore(Step 6)는 CDK 밖에서 만들어지므로 수동 재실행이 필요하다.

## 로컬 개발 환경 / Local toolchain

사내망 특성상 표준 설치가 막혀 있어 sudo 없이 `~/.local`에 설치돼 있다.

- `aws`, `node`, `cdk`, `session-manager-plugin` → `~/.local/bin`
- npm은 사내 Nexus를 바라본다: `registry=https://nexus.mng.musinsa.io/repository/npm-all/`
  (공용 npmjs.org는 프록시가 차단)
- 사내 SSL 검사 때문에 CA 번들이 필요하다:
  ```bash
  export NODE_EXTRA_CA_CERTS="$HOME/.local/share/ca/ca-bundle.pem"
  export AWS_CA_BUNDLE="$HOME/.local/share/ca/ca-bundle.pem"
  ```
  없으면 `SELF_SIGNED_CERT_IN_CHAIN` / `CERTIFICATE_VERIFY_FAILED`로 실패한다.

## 알려진 함정 / Known traps

| 증상 | 원인 | 조치 |
|---|---|---|
| 대시보드 수치가 전부 0 | Steampipe 서비스 중지 | `bash scripts/09-start-all.sh` |
| `/vscode` 접속 타임아웃, 주소창에 `:8889` | nginx가 리다이렉트에 내부 포트를 붙임 | nginx 설정에 `absolute_redirect off; port_in_redirect off;` (user-data에 반영됨) |
| 로그아웃해도 로그인 화면이 안 뜸 | 앱 쿠키만 지우면 ALB 세션이 살아있음 | `/api/auth`가 `AWSELBAuthSessionCookie-*` 만료 + Cognito 로그아웃 URL 반환 |
| `cdk bootstrap`이 customDomain 없다고 실패 | 부트스트랩도 앱을 synth한다 | 도메인 입력 이후로 부트스트랩 순서를 옮김 (`00-deploy-infra.sh`) |
| AI 응답 모델이 예상과 다름 | UI 라벨과 실제 모델 맵 불일치 | `src/app/ai/page.tsx`와 `src/app/api/ai/route.ts`의 키를 함께 확인 |
