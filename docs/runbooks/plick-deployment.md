# Runbook: plick 배포 / plick Deployment

이 계정(815090125359, ap-northeast-2)에 배포할 때만 해당하는 사항. 일반 설치 절차는
`docs/INSTALL_GUIDE.md`를 따르고, 아래는 **이 환경에서 다르게 동작하거나 사람이 개입해야 하는 지점**만 정리한다.

Environment-specific notes for the plick account. Follow `docs/INSTALL_GUIDE.md` for the
general flow; this file only covers what differs here or needs manual intervention.

## 현재 구성 / Current setup

| 항목 | 값 |
|---|---|
| 계정 / Account | `815090125359`, ap-northeast-2 |
| 대시보드 / Dashboard | `https://awsops.plick.co.kr/` |
| VSCode | `https://awsops.plick.co.kr/vscode` |
| 인증 / Auth | Cognito → ALB `authenticate-cognito` (기본 액션 + `/vscode*` 규칙 양쪽) |
| AI 모델 / Model | `global.anthropic.claude-opus-4-6-v1` |
| EC2 | `awsops-server`, t4g.xlarge (ARM64), 프라이빗 서브넷 |
| VPC | `awsops-vpc` `10.10.0.0/16` — 전용 VPC (plick dev/prod와 분리) |
| 레포 / Repo | `big-cute-team/plick-awsops`, EC2 체크아웃은 `/home/ec2-user/plick-awsops` |
| 태그 / Tags | `Project=awsops`, `Environment=dev`, `ManagedBy=cdk` |

## 제약 / Constraints

- **Cost Explorer 사용 불가.** 조직 SCP(`p-5soyo0ar`)가 `ce:GetCostAndUsage`를 명시적으로
  거부한다. 계정 안에서는 우회 불가 — 관리 계정(`403164878212`)에서 정책을 바꿔야 한다.
  `data/config.json`의 `costEnabled: false`는 정상이며, Cost 페이지와 cost 라우트는 쓸 수 없다.

- **Opus 4.7 / 4.8 / 5, Sonnet 5, Fable 5 는 계정 엔타이틀먼트가 없다.**
  `InvokeModel`이 `AccessDenied: not available for this account`로 실패한다.
  실제로 호출 가능한 모델은 **Opus 4.6, Opus 4.5, Sonnet 4.6, Sonnet 4.5, Haiku 4.5** 뿐이다.
  업스트림 기본값이 Opus 4.8이므로, 포크를 갱신할 때마다 모델 ID를 확인할 것.

- **Anthropic 사용 사례 양식은 제출 완료.** 2026-09-10, 계정당 1회.
  미제출 상태에서는 모든 Anthropic 모델이 `ResourceNotFoundException: Model use case
  details have not been submitted` 로 실패한다. 제출 후 전파에 ~15분 걸린다.
  상태 확인: `aws bedrock get-use-case-for-model-access --region ap-northeast-2`

- **이 계정은 AWS Innovation Sandbox 관리 대상이다** (`StackSet-Isb-myisb-SandboxAccountResources`).
  리스가 끝나면 리소스가 정리될 수 있다. 스크립트로 대부분 재구축되지만
  **`data/config.json`은 `.gitignore` 대상이라 레포에 없다** — AgentCore Runtime ARN,
  Code Interpreter, Memory ID가 여기 있으니 따로 백업해 둘 것.

## 재배포 시 주의사항 / Redeploy gotchas

### 1. 서버는 systemd로만 관리한다

`03-build-deploy.sh`와 `09-start-all.sh`는 Next.js를 `nohup ... &`로 띄운다. 이 프로세스는
**SSM 세션이 끊기거나 재부팅되면 조용히 죽고 아무도 되살리지 않는다.** 증상이 고약하다 —
ALB 타겟이 unhealthy가 되어 502가 뜨는데 Steampipe는 멀쩡해서 원인이 눈에 안 띈다.

```bash
sudo bash scripts/13-setup-steampipe-systemd.sh   # steampipe.service
sudo bash scripts/14-setup-app-systemd.sh         # awsops.service
```

이후 `sudo systemctl {start|stop|restart} {awsops|steampipe}`로만 다룬다.
CLI `steampipe service stop`은 `Restart=always`가 즉시 되돌린다.

### 2. CI/CD 배포와 수동 스크립트를 동시에 돌리지 않는다

배포는 `git reset --hard` + `npm ci` + `npm run build`를 EC2의 같은 체크아웃에서 수행한다.
EC2에서 설치 스크립트를 돌리는 중에 누가 main에 푸시하면, reset이 진행 중인 수정을 지우고
빌드 두 개가 `.next`를 서로 덮어써 산출물이 깨진다. 2026-09-10에 이 방식으로 대시보드가
내려갔다(`.next/BUILD_ID` 소실 → 크래시 루프).

`scripts/lib/deploy-lock.sh`가 `03-build-deploy`, `6c`, `6e`와 배포 워크플로를 상호 배제한다.
락은 `/var/tmp/awsops-deploy.lock`이며, 홀더 프로세스가 죽으면 자동 회수된다.

### 3. Cognito 인증 액션은 CDK가 관리하지 않는다

`cdk deploy`가 443 리스너를 다시 쓰면 `authenticate-cognito`가 **사라진다.**
배포 후 반드시 확인하고, 없으면 `05-setup-cognito.sh`를 다시 돌린다.

```bash
L=$(aws cloudformation describe-stacks --stack-name AwsopsStack --region ap-northeast-2 \
     --query "Stacks[0].Outputs[?OutputKey=='HttpsListenerArn'].OutputValue|[0]" --output text)
aws elbv2 describe-listeners --listener-arns $L --region ap-northeast-2 \
  --query 'Listeners[0].DefaultActions[].Type'
aws elbv2 describe-rules --listener-arn $L --region ap-northeast-2 \
  --query "Rules[?Priority=='10'].Actions[].Type"
```

기본 액션(대시보드)과 `/vscode*` 규칙 **양쪽 모두** 인증이 필요하다. 업스트림은 이 둘이
반대(기본=VSCode, `/awsops*`=대시보드)라, 우선순위를 하드코딩한 옛 스크립트는
`/vscode`를 무인증으로 방치했다.

### 4. Step 6에는 설치용 권한이 임시로 필요하다

EC2 역할(`awsops-ec2-role`)은 평소 `ReadOnlyAccess`만 갖는다. Step 6을 (재)실행할 때만
로컬에서 임시 정책을 붙였다가 끝나면 회수한다. 남겨두면 `/vscode`에 로그인할 수 있는
사람이 계정에서 Lambda·IAM 역할·ECR을 만들 수 있게 된다.

```bash
aws iam put-role-policy --role-name awsops-ec2-role --policy-name TempAgentCoreSetup \
  --policy-document '{"Version":"2012-10-17","Statement":[
    {"Effect":"Allow","Action":["iam:CreateRole","iam:AttachRolePolicy","iam:PutRolePolicy",
      "iam:TagRole","iam:PassRole","iam:CreateServiceLinkedRole","iam:GetRole",
      "iam:DeleteRolePolicy"],"Resource":"*"},
    {"Effect":"Allow","Action":["ecr:*","lambda:*","bedrock-agentcore:*",
      "bedrock-agentcore-control:*","ec2:CreateSecurityGroup",
      "ec2:AuthorizeSecurityGroupIngress","ec2:CreateTags"],"Resource":"*"}]}'

# ... EC2에서 scripts/06-setup-agentcore.sh 실행 ...

aws iam delete-role-policy --role-name awsops-ec2-role --policy-name TempAgentCoreSetup
```

### 5. AgentCore Runtime을 갱신할 때는 6a를 재실행하지 않는다

6a는 `create-agent-runtime`이라 Runtime이 중복 생성된다. 이미지만 바꿔 반영하려면:

```bash
# EC2에서 — 이미지 재빌드 + 푸시
aws ecr get-login-password --region ap-northeast-2 | \
  docker login --username AWS --password-stdin 815090125359.dkr.ecr.ap-northeast-2.amazonaws.com
docker buildx build --no-cache --platform linux/arm64 \
  -t 815090125359.dkr.ecr.ap-northeast-2.amazonaws.com/awsops-agent:latest --push agent/

# Runtime 갱신 — --role-arn 과 --network-configuration 이 필수다
aws bedrock-agentcore-control update-agent-runtime \
  --agent-runtime-id <RUNTIME_ID> \
  --role-arn arn:aws:iam::815090125359:role/AWSopsAgentCoreRole \
  --agent-runtime-artifact '{"containerConfiguration":{"containerUri":"815090125359.dkr.ecr.ap-northeast-2.amazonaws.com/awsops-agent:latest"}}' \
  --network-configuration '{"networkMode":"PUBLIC"}' \
  --region ap-northeast-2
```

READY가 될 때까지 기다린 뒤 테스트한다.

### 6. EC2를 재생성하면 Step 5·6·13·14를 다시 해야 한다

nginx(`/vscode` 프록시)는 user-data에 코드화돼 있어 자동 설치된다. 하지만 Cognito(Step 5),
AgentCore(Step 6), systemd 유닛(13·14)은 CDK 밖에서 만들어지므로 수동 재실행이 필요하다.

## AgentCore 진단 / Debugging AgentCore

AI가 Gateway 라우트에서 `via: Bedrock Direct (fallback)`로 응답하면 Runtime 호출이
실패한 것이다. `route.ts`가 실패를 조용히 삼키고 Bedrock으로 넘어가므로 **앱은 정상으로 보인다.**

확인 순서:

```bash
# 1. 앱 로그 — AgentCore 오류가 여기 남는다
grep -i agentcore /var/log/awsops.log | tail

# 2. 컨테이너 로그 — 진짜 원인은 여기 있다
aws logs tail /aws/bedrock-agentcore/runtimes/<RUNTIME_ID>-DEFAULT \
  --region ap-northeast-2 --since 15m --format short
```

**로그 그룹이 아예 없다면 `AWSopsAgentCoreRole`에 로그 권한이 없는 것이다.**
권한이 없으면 컨테이너가 기동에 실패하고, 원인을 담을 로그 그룹조차 생기지 않아
`"An error occurred when starting the runtime. Please check your CloudWatch logs"` 만 보인다.
06a가 `Observability` 인라인 정책(logs, X-Ray, PutMetricData)을 붙인다.

정상 기동 시 로그에 이렇게 찍힌다:

```
[Agent] Auto-discovered 8 gateways: ['container','cost','data','iac','monitoring','network','ops','security']
INFO | bedrock_agentcore.app | Invocation completed successfully (6.4s)
```

## 알려진 함정 / Known traps

| 증상 | 원인 | 조치 |
|---|---|---|
| 대시보드 수치가 전부 0 | Steampipe 중지 | `sudo systemctl start steampipe` |
| 사이트 502, Steampipe는 정상 | Next.js가 nohup으로 떠서 세션과 함께 죽음 | `sudo bash scripts/14-setup-app-systemd.sh` |
| `.next/BUILD_ID` 없음 → 크래시 루프 | 빌드 두 개가 동시 실행 | 락 확인(`/var/tmp/awsops-deploy.lock`), 재빌드 후 재시작 |
| AI가 Gateway 라우트에서 폴백 | 컨테이너 기동 실패 | 위 "AgentCore 진단" 참조 |
| 컨테이너가 `ImportError`로 기동 실패 | `mcp` 버전 미고정 → 2.x 설치 | Dockerfile이 `mcp>=1.23,<2`로 고정. `streamable_http_sigv4.py`가 1.x 내부에 의존 |
| 이미지를 고쳤는데 반영 안 됨 | `buildx --push`는 **로컬 이미지 저장소를 갱신하지 않는다** | 검증은 `docker rmi` 후 `docker pull`로 ECR 이미지를 받아서 |
| Memory가 `local-fallback` | 응답 필드는 `id`인데 `memoryId`를 읽던 파서 버그 | 06f 수정됨. 서울 리전은 Memory API를 지원한다 |
| 6c가 Lambda 17개에서 멈춤 | `tag:Name` 필터가 대소문자 구분 | 인스턴스 Name 태그는 `awsops-server` 고정 |
| GitHub Actions OIDC assume 실패 | 이 레포는 불변 ID 형식 subject를 쓴다 | 신뢰 정책에 `repo:big-cute-team@288523725/plick-awsops@1363554736:environment:dev` 포함 |

## CI/CD

main 푸시 → `.github/workflows/deploy.yml` → OIDC(`plick-awsops-github-role-dev`) →
SSM Send Command → EC2에서 `git reset --hard` + `npm ci` + `npm run build` + `systemctl restart`.

EC2가 프라이빗 서브넷이라 인바운드가 없다. 러너가 접속하는 대신 SSM으로 명령을 밀어넣는다.
대상 인스턴스는 `Name=awsops-server` 태그로 찾으므로 EC2를 재생성해도 워크플로 수정이 필요 없다.
역할은 그 태그가 붙은 인스턴스로만 `ssm:SendCommand`를 허용한다.

배포는 EC2에서 빌드하므로 **7~9분** 걸린다.
