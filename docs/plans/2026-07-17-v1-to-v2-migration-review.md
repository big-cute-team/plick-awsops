# v1 → v2 (ECS Fargate/Aurora/Terraform) 마이그레이션 검토

- **작성일**: 2026-07-17
- **대상**: upstream(whchoi98/awsops) 오너 환경 — 단일 Host 계정, ap-northeast-2, prod EC2 10.254.2.165
- **분석 근거**: fork(Atom-oh) v2 트리 `pr/32` (head `21495f1d`, 2026-07-17 fetch), 8-에이전트 도메인 분석 + 독립 완결성 감사
- **결론**: **조건부 GO — 단, 즉시 컷오버는 비권고.** 아래 "차단 이슈 3건 + 선행 결정 5건" 해소 후 스테이징 검증(2주)을 거쳐 단계적 진행 권장.

---

## 1. 총평

fork의 v2는 단순 컨테이너화가 아니라 **별개 제품**이다: 데이터 계층이 Steampipe 라이브 SQL(380+ 테이블)에서 Aurora 스냅샷(33타입, 15분 sync)으로, 인프라가 CDK/EC2에서 Terraform/ECS Fargate로, 배포가 셸스크립트에서 Makefile 컨트롤러 모델로 전면 교체된다.

**품질은 높다**: 테스트 260+ 파일(v1은 0), 런북 15종, ULID 마이그레이션 러너(advisory lock + checksum), 배포 circuit breaker, 그리고 무엇보다 **fork 자신이 2026-07-09에 실전 컷오버를 완료한 이력**(ADR-016 5-phase)이 문서로 남아 있어 절차 템플릿의 재사용 가치가 크다.

**그러나 fork의 "안전" 판정은 자기 환경(Cognito 실사용자 0명, alert 발신자 0건, 자체 v1 기준 갭 감사) 한정**이므로 upstream은 실사를 전부 재실행해야 하며, upstream 전용 기능(zh i18n 등)의 회귀와 배포 blocker 3건이 확인됐다.

## 2. 아키텍처 대비

| 항목 | v1 (현재) | v2 (pr/32) |
|------|-----------|------------|
| 실행 | EC2 t4g.2xlarge + systemd | ECS Fargate web (ARM64 0.5vCPU/1GB, desired 1, 오토스케일링 없음) |
| 데이터 | Steampipe 내장 PG :9193 라이브 쿼리 (380+ 테이블, 5분 캐시) | Aurora Serverless v2 (PG 17.9, 0.5~4 ACU, IAM DB auth) + Steampipe Fargate SPOT sync (33타입, 15분) |
| IaC | CDK (`infra-cdk/`) | Terraform (`terraform/v2/bootstrap`+`foundation`, S3 backend + native lockfile, TF≥1.15) |
| 인증 | Cognito 풀 (CDK) + Lambda@Edge | **신규** Cognito 풀 + Lambda@Edge (RS256 JWKS 검증 — VERIFY.md TODO는 stale, 코드는 해결됨) |
| AI | AgentCore (scripts 06a-06f 산물) | **재생성** — Terraform 스켈레톤 + `provision.py` (기본 `agentcore_enabled=false`) |
| 배포 | scripts 00-13 + SSM | `make configure/migrate/deploy/upgrade` (컨트롤러 수동 실행, CI 자동 배포 없음) |
| URL | `/awsops` basePath | 루트 `/` 서빙 (**딥링크 단절** — 리다이렉트 필요) + 커스텀 도메인/Route53 zone **하드 요구** |
| 상태 | data/*.json + S3 | Aurora 31테이블 + 신규 S3 (diagnosis_artifacts) |

## 3. 얻는 것 / 잃는 것

### 얻는 것
- 인시던트 라이프사이클(webhook + storm cap), K8sGPT EKS 진단, architecture_intent(의도-실제 비교), 커스텀 에이전트 플랫폼, chat threads 영구화, Aurora 토폴로지 그래프, 비동기 워커 백본(SQS+SFN)
- 테스트 스위트(pytest 73 + vitest 187) + PR 게이트, 멀티 리전 스코핑(account_regions)
- 비용 절감 (아래 §4)

### 잃는 것 (owner 승인 필요)
| 상실 항목 | 상세 |
|-----------|------|
| **zh 중국어 i18n** | upstream f37c144(분기 후) — v2는 ko/en만, 그것도 셸/내비 문자열만 |
| **라이브 ad-hoc SQL** | 380+ 테이블 → 큐레이션 33타입, 신선도 5분→15분, 새 타입 추가가 SQL 1파일 → 코드 3단계 |
| **MSK/OpenSearch/ElastiCache 메트릭 페이지** | v2 metrics API는 ec2/rds만 지원 |
| **ECS container-cost** | 대체재 없음 (v2 OpenCost는 EKS 전용) |
| **외부 데이터소스 7종→5종** | Jaeger/Dynatrace/Datadog 탈락 (Mimir 신규) |
| **Trivy CVE 스캐닝, 사용자용 Code Interpreter, PPTX 리포트** | v2 미지원 |
| **페이지 40→21** | 서비스별 페이지가 inventory/[type] 템플릿으로 통합 |

※ PDF/DOCX 진단 리포트는 v2 `exporters.py`(playwright PDF + python-docx)로 **대체 존재** — fork 갭 감사 문서의 "drop" 분류는 코드보다 낡은 오기.

## 4. 비용 (ap-northeast-2, Pricing API 2026-07 실단가)

| 구분 | 월액 |
|------|------|
| v1 현행 | **$316–370** (EC2 t4g.2xlarge $243 지배적 + EBS $9 + NAT $43 + ALB $16 + VPCe $57*) |
| v2 목표 | **$175–180** (Aurora floor 0.5 ACU $73 + Fargate web $17 + Steampipe $20 + NAT/ALB/기타) |
| **절감** | **약 45–53% (-$140~195/월)** |
| 병행(dual-run) 기간 | **$500–545/월** — 기간 단축이 절감 실현의 관건 |

리스크: Aurora는 scale-to-zero 아님(floor $73 고정), max 4 ACU 지속 시 $584/월, standard 스토리지 I/O 별도 과금, web task 상향 시 선형 증가. *VPCe는 기존 VPC 재사용 배포면 해당 없음 — **Cost Explorer 실측 선행 필요**.

## 5. 데이터 이관 맵

| v1 상태 | v2 목적지 | 도구 | 판정 |
|---------|-----------|------|------|
| data/inventory/ | inventory_snapshots | `backfill-v1.mjs` (멱등) | ✅ 이관 가능 (fork 실측 693행) |
| data/cost/ | cost_snapshots | 〃 | ✅ 이관 가능 (24행) |
| data/memory/ (AI 대화) | agentcore_memory 테이블 존재 | **임포터 없음** | ⚠️ 손실 — 이관하려면 자체 개발 |
| data/report-schedule.json | report_schedules | 임포터 없음 | ⚠️ 수동 재등록 |
| data/config.json (accounts/datasources/adminEmails) | accounts 테이블 + Secrets Manager | 임포터 없음 | ⚠️ 수동 재등록 |
| 진단 리포트 (S3 + data/reports/) | 신규 diagnosis_artifacts 버킷 | 경로 없음 | ⚠️ v1 버킷 보존으로 갈음 권장 |
| Cognito 사용자 | **신규 풀** | 비밀번호 이관 불가 | ⚠️ 재생성 + `--permanent` 필수 (누락 시 락아웃) |
| AgentCore (runtime/8GW/19λ/memory) | provision.py 재생성 | 재사용 없음 | ⚠️ 대화 이력·통계 소실 |

upstream v1에는 dual-write 계층이 없으므로 **컷오버 당일 백필 최종 재실행**으로 델타를 닫아야 한다 (백필은 멱등).

## 6. 배포 차단 이슈 (코드 수정 필요)

1. **`cognito_domain_prefix` 기본값 `awsops-v2-auth`** — 'aws' 문자열은 Cognito 금지. 기본값 apply 즉시 실패 → 반드시 override (variables.tf:67).
2. **`edge.tf:139` moved 블록의 `atomai.click` 하드코딩** — upstream 도메인에서 plan 에러 유발, 삭제 필요.
3. **CloudFront-VPCOrigins-Service-SG 순환 의존** (workload.tf:389) — 이 AWS 관리형 SG는 VPC에 첫 VPC Origin이 생긴 후에야 존재 → **프레시 apply 실패 가능성 높음**. fork는 점진 적용이라 안 밟은 경로. 2단계 apply 절차 필요.
4. (부가) `pr-review.yml`/`deploy-guide.yml`은 fork 전용 self-hosted runner(`awsops-claude-arm`) 의존 — upstream에서 비활성화 필요.
5. (부가) ECR 이미지 태그가 MUTABLE `web-latest` 단일 — **이미지 롤백 경로 부재**, digest 고정 또는 버전 태그 절차 추가 권장.
6. (부가) Aurora `deletion_protection=false` + `skip_final_snapshot=true` — 컷오버 전 반드시 반전.

## 7. 권장 단계별 계획 (upstream 각색판)

- **Phase 0 — 사전 결정** (1주): ① 커스텀 도메인/Route53 zone 확보 여부 확정 (없으면 NO-GO) ② §3 상실 목록 항목별 keep/drop 승인 ③ 병행 기간 예산 승인 ④ prod data/ 실사 (SSM: memory 사용자 수, 리포트 수, datasources 설정)
- **Phase 1 — 스테이징 배포** (2주): §6 차단 이슈 수정 → 별도 서브도메인으로 v2 전체 스택 배포 (게이트: steampipe/workers/agentcore=true 영속화) → Aurora ACU 관측, sync 성공률 ≥99% 확인, `make agentcore --smoke`
- **Phase 2 — 데이터 준비**: 백필 dry-run → 실행 (errored=0, 멱등 재실행 inserted=0 확인), Cognito 사용자 사전 생성(`--permanent`), 데이터소스/스케줄 재등록
- **Phase 3 — 도메인 컷오버**: 백필 최종 재실행 → `update-domain-association` + Route53 전환 (fork 검증 절차, 순단 최소화이지 무중단 아님) → `/awsops/*` → `/` 리다이렉트
- **Phase 4 — v1 정지 + 유예 2주**: EC2 stop(terminate 금지) + CloudFront disable, 롤백 런북 유지 ("v2 기간 Aurora 데이터는 롤백 시 포기" 정책 서명)
- **Phase 5 — 폐기**: cdk destroy(`--retain-resources` 주의 — fork도 미실행한 Phase 4는 실전 검증 안 됨) + AgentCore 고아 리소스 육안 삭제

## 8. Go/No-Go 게이트 (12)

1. 기능 패리티: 681b7c41 기준 갭 감사에 owner 서명 (fork 감사 재활용 불가 — 기준 트리가 다름)
2. 인증: v1 사용자 100% v2 풀 사전 생성 + 양 로그인 경로 e2e + 위조/만료 토큰 처리 실측
3. 백필: errored=0 + 행수 일치 + 멱등 확인
4. Aurora: deletion_protection=true + 수동 스냅샷 + 복원 리허설 1회
5. 게이트 플래그: tfvars 영속화 + apply 후 plan=No changes (**플래그 누락 재apply = 게이트 인프라 전부 destroy** footgun 주의)
6. 인벤토리: 33타입 전부 행 존재 + sync 7일 성공률 ≥99%
7. 멀티 어카운트(해당 시): 스포크 role trust에 v2 task role 반영
8. 도메인: zone 확정 + 전환 리허설 + 딥링크 처리 결정
9. 롤백: 윈도우/데이터 정책 서명 + 실리소스 ID 기입 런북
10. 비용: 병행 월액 산정표 + 예산 승인
11. 시크릿: 데이터소스 재입력 + 헬스체크 green + state/tfvars 보관 정책
12. 운영 역량: owner가 make configure→migrate→deploy 1회 완주

## 9. 미해결 질문 (owner/fork 확인 필요)

- ~~prod data/ 실물~~ → **§10에서 실측 완료**
- ~~현 접속 도메인 구조~~ → **§10에서 실측 완료**
- SCP가 iam:ListMFADevices 차단하는지 — v1 CLAUDE.md가 `mfa_enabled`를 SCP 차단 컬럼으로 문서화하고 있어 **차단으로 봐야 함** → v2 sync_lambda의 iam_user 쿼리(`ignore_error_codes` 부재)는 스테이징에서 실패 검증 필수
- fork의 Phase 4(완전 삭제)가 이후 실제 실행됐는지 + agent.py의 v1/v2 게이트웨이 이름 해석 우선순위(공존기 v1 우선) 실측
- v2 diagnosis 섹션(base 8/deep 14+intent)과 v1 15섹션의 내용 동등성

## 10. Phase 0 실사 결과 (2026-07-17 실측)

### 호재 — 리스크 4건 해소
| 항목 | 실측 | 판정 |
|------|------|------|
| **도메인** | `awsops.whchoi.net` (CloudFront `E2SN5LJ6IZRHYA`, AwsopsStack) + `whchoi.net` public hosted zone 동일 계정 보유 | ✅ **v2 하드 전제 충족** — fork의 `update-domain-association` 동일 계정 alias 이동 절차 그대로 적용 가능 |
| **AI 대화 이력** | data/memory/: user dir 0개, 파일 1개 | ✅ 사실상 없음 — "수용 손실" 부담 소멸 |
| **외부 데이터소스** | config.json datasources = **0건** | ✅ 7종→5종 회귀(Jaeger/Dynatrace/Datadog 탈락) **이 환경에선 무관** |
| **진단 스케줄** | report-schedule.json 부재 | ✅ 이관 불요 |

### 부담 — 확정된 작업 2건
| 항목 | 실측 | 필요 작업 |
|------|------|-----------|
| **Cognito 사용자** | `AWSops-UserPool`(ap-northeast-2_eLMgNPO18)에 **실사용자 11명** (CONFIRMED 10 + UNCONFIRMED 1) | fork(placeholder 1명)와 결정적으로 다름 — 전원 v2 풀 사전 생성(`admin-set-user-password --permanent`) + 비밀번호 재설정 공지 계획 필수 |
| **진단 리포트 이력** | data/reports 메타 **41건** (reportBucket=null — 동적 버킷 사용) | v2에서 비가시 — v1 리포트 저장소 보존 정책 필요 |

### 백필 규모 (fork 대비)
- inventory 42파일 / cost 69파일, data/ 총 23MB (fork 실측: inventory 26 scanned·cost 24 — upstream이 더 큼, dry-run으로 행수 검증)
- config.json 이관 대상: accounts 1(Host 단일), adminEmails 1, customerName/customerLogo 브랜딩, opencostEndpoint, fargatePricing — 수동 재등록 목록 확정

---
*생성: Claude Code 멀티 에이전트 검토 (8 도메인 분석 + 완결성 감사) + Phase 0 실사, 2026-07-17*
