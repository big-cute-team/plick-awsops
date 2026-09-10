#!/bin/bash
set -e
################################################################################
#                                                                              #
#   Step 6a: AgentCore Runtime Setup                                           #
#                                                                              #
#   Creates:                                                                   #
#     1. IAM Role (AgentCore - Bedrock + ECR)                                  #
#     2. ECR Repository                                                        #
#     3. ARM64 Docker image (docker buildx)                                    #
#     4. AgentCore Runtime (Strands agent)                                     #
#     5. Runtime Endpoint                                                      #
#                                                                              #
#   Known issues handled:                                                      #
#     - Docker image must be arm64 (docker buildx --platform linux/arm64)     #
#     - SDK v3: use response.transformToString() (not read())                 #
#                                                                              #
################################################################################

# -- Colors & common variables / 색상 및 공통 변수 ----------------------------
GREEN='\033[0;32m'; RED='\033[0;31m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; NC='\033[0m'
WORK_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REGION="${AWS_DEFAULT_REGION:-ap-northeast-2}"

# -- Helper: run command with error handling / 에러 핸들링 헬퍼 ---------------
run_or_fail() {
    local step_name="$1"; shift
    local output
    if ! output=$("$@" 2>&1); then
        echo -e "  ${RED}ERROR in ${step_name}:${NC}"
        echo "$output" | head -20
        echo ""
        echo -e "  ${YELLOW}Hint: Check IAM permissions for this instance role.${NC}"
        echo -e "  ${YELLOW}Required: IAM, ECR, Bedrock AgentCore, Docker / 필요 권한: IAM, ECR, Bedrock AgentCore, Docker${NC}"
        exit 1
    fi
    echo "$output"
}

# -- Pre-flight: Docker check / Docker 사전 체크 --------------------------------
if ! command -v docker &>/dev/null; then
    echo -e "${RED}ERROR: Docker not installed. CDK UserData should install Docker automatically.${NC}"
    echo -e "${YELLOW}Fix: sudo dnf install -y docker && sudo systemctl start docker${NC}"
    exit 1
fi
if ! docker info &>/dev/null; then
    echo -e "${RED}ERROR: Docker daemon not running.${NC}"
    echo -e "${YELLOW}Fix: sudo systemctl start docker${NC}"
    exit 1
fi

# -- Preflight: verify AWS credentials / AWS 자격 증명 확인 -------------------
echo ""
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text 2>&1) || {
    echo -e "${RED}ERROR: AWS credentials not available / AWS 자격 증명을 사용할 수 없습니다${NC}"
    echo "  $ACCOUNT_ID"
    echo ""
    echo -e "${YELLOW}Hint: Attach IAM role with sufficient permissions to this EC2 instance${NC}"
    echo -e "${YELLOW}      Required: IAM, ECR, Bedrock, AgentCore / 필요: IAM, ECR, Bedrock, AgentCore 권한${NC}"
    exit 1
}

echo ""
echo -e "${CYAN}=================================================================${NC}"
echo -e "${CYAN}   Step 6a: AgentCore Runtime Setup${NC}"
echo -e "${CYAN}=================================================================${NC}"
echo ""
echo "  Region:  $REGION"
echo "  Account: $ACCOUNT_ID"
echo ""

# -- [1/5] Create IAM Role / IAM 역할 생성 ------------------------------------
echo -e "${CYAN}[1/5] Creating AgentCore IAM role...${NC}"

# Create role (ignore if already exists / 이미 존재하면 무시)
aws iam create-role --role-name AWSopsAgentCoreRole \
    --assume-role-policy-document '{
        "Version": "2012-10-17",
        "Statement": [
            {"Effect": "Allow", "Principal": {"Service": "bedrock.amazonaws.com"}, "Action": "sts:AssumeRole"},
            {"Effect": "Allow", "Principal": {"Service": "bedrock-agentcore.amazonaws.com"}, "Action": "sts:AssumeRole"}
        ]
    }' \
    --tags Key=Project,Value=awsops Key=Environment,Value=dev Key=ManagedBy,Value=script \
    2>/dev/null || true

# Attach managed policy / 관리형 정책 연결
run_or_fail "IAM attach-role-policy" \
    aws iam attach-role-policy --role-name AWSopsAgentCoreRole \
    --policy-arn arn:aws:iam::aws:policy/AmazonBedrockFullAccess

# Attach inline policy / 인라인 정책 연결
run_or_fail "IAM put-role-policy (ECRAndLambda)" \
    aws iam put-role-policy --role-name AWSopsAgentCoreRole --policy-name ECRAndLambda \
    --policy-document "{
        \"Version\": \"2012-10-17\",
        \"Statement\": [{
            \"Effect\": \"Allow\",
            \"Action\": [\"ecr:*\", \"lambda:InvokeFunction\", \"lambda:GetFunction\", \"bedrock-agentcore:*\"],
            \"Resource\": \"*\"
        }]
    }"

echo "  AWSopsAgentCoreRole: created"
echo "  Waiting for IAM propagation (10s)..."
sleep 10

# -- [2/5] Create ECR Repository / ECR 리포지토리 생성 -------------------------
echo ""
echo -e "${CYAN}[2/5] Creating ECR repository...${NC}"
# Ignore if already exists / 이미 존재하면 무시
aws ecr create-repository --repository-name awsops-agent \
    --tags Key=Project,Value=awsops Key=Environment,Value=dev Key=ManagedBy,Value=script \
    --region "$REGION" 2>/dev/null || true
ECR_URI="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/awsops-agent"
echo "  ECR: $ECR_URI"

# -- [3/5] Build and Push Docker Image (ARM64) / Docker 이미지 빌드 -----------
#   KNOWN ISSUE: AgentCore Runtime requires arm64 Docker image.
echo ""
echo -e "${CYAN}[3/5] Building Docker image (arm64)...${NC}"
echo -e "  ${YELLOW}NOTE: arm64 required for AgentCore Runtime${NC}"

# ECR login / ECR 로그인
ECR_LOGIN_OUTPUT=$(aws ecr get-login-password --region "$REGION" 2>&1) || {
    echo -e "  ${RED}ERROR: ECR login failed / ECR 로그인 실패${NC}"
    echo "  $ECR_LOGIN_OUTPUT"
    echo -e "  ${YELLOW}Hint: Instance role needs ecr:GetAuthorizationToken permission${NC}"
    exit 1
}
echo "$ECR_LOGIN_OUTPUT" | docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com" 2>/dev/null

docker buildx create --use 2>/dev/null || true
docker buildx build --platform linux/arm64 \
    -t "${ECR_URI}:latest" --push \
    "$WORK_DIR/agent/" 2>&1 | tail -5 || {
    echo -e "  ${RED}ERROR: Docker build/push failed / Docker 빌드/푸시 실패${NC}"
    echo -e "  ${YELLOW}Hint: Check Docker daemon, ECR permissions, and Dockerfile in agent/ / Docker 데몬, ECR 권한, agent/Dockerfile 확인${NC}"
    exit 1
}
echo "  Image: ${ECR_URI}:latest (arm64)"

# -- [4/5] Create AgentCore Runtime / AgentCore 런타임 생성 --------------------
echo ""
echo -e "${CYAN}[4/5] Creating AgentCore Runtime (Strands agent)...${NC}"
sleep 5

RT_RESULT=$(aws bedrock-agentcore-control create-agent-runtime \
    --agent-runtime-name awsops_agent \
    --role-arn "arn:aws:iam::${ACCOUNT_ID}:role/AWSopsAgentCoreRole" \
    --agent-runtime-artifact "{\"containerConfiguration\":{\"containerUri\":\"${ECR_URI}:latest\"}}" \
    --network-configuration '{"networkMode":"PUBLIC"}' \
    --tags Project=awsops,Environment=dev,ManagedBy=script \
    --region "$REGION" --output json 2>&1) || {
    echo -e "  ${RED}ERROR: Failed to create AgentCore Runtime / AgentCore 런타임 생성 실패${NC}"
    echo "$RT_RESULT" | head -10
    echo -e "  ${YELLOW}Hint: Check bedrock-agentcore permissions and ECR image availability${NC}"
    echo -e "  ${YELLOW}      필요 권한: bedrock-agentcore:CreateAgentRuntime, ECR 이미지 접근${NC}"
    exit 1
}

RT_ID=$(echo "$RT_RESULT" | python3 -c "import json,sys;print(json.load(sys.stdin).get('agentRuntimeId',''))" 2>/dev/null || echo "")
RT_ARN=$(echo "$RT_RESULT" | python3 -c "import json,sys;print(json.load(sys.stdin).get('agentRuntimeArn',''))" 2>/dev/null || echo "")
echo "  Runtime ID:  $RT_ID"
echo "  Runtime ARN: $RT_ARN"

if [ -z "$RT_ID" ]; then
    echo -e "  ${RED}ERROR: Runtime created but ID not found in response / 런타임 생성됐으나 ID를 찾을 수 없음${NC}"
    echo "  Response: $RT_RESULT"
    exit 1
fi

# -- [5/5] Wait for the DEFAULT endpoint / DEFAULT 엔드포인트 대기 --------------
# 앱은 DEFAULT 엔드포인트로 호출한다(src/app/api/ai/route.ts 의 qualifier: 'DEFAULT').
# DEFAULT 는 Runtime 생성 시 함께 만들어지므로 여기서 별도로 만들 것이 없다.
#
# 예전에는 여기서 awsops_endpoint 라는 이름의 엔드포인트를 추가로 만들었는데,
#   - 앱이 그 엔드포인트를 쓰지 않았고,
#   - Runtime 이 아직 CREATING 이면 ConflictException 으로 실패하면서 exit 1 해
#     6b~6f 까지 통째로 막았다.
# Runtime 은 이미 만들어진 상태라 6a 를 재실행하면 Runtime 이 중복 생성된다.
#
# The app invokes with qualifier 'DEFAULT', and DEFAULT is created with the runtime.
# This step used to create an extra named endpoint the app never used, and failed the
# whole script with ConflictException while the runtime was still CREATING — which
# blocked 6b-6f, and re-running 6a would have created a duplicate runtime.
echo ""
echo -e "${CYAN}[5/5] Waiting for the runtime and its DEFAULT endpoint...${NC}"

for i in $(seq 1 60); do
    RT_STATUS=$(aws bedrock-agentcore-control get-agent-runtime \
        --agent-runtime-id "$RT_ID" --region "$REGION" \
        --query 'status' --output text 2>/dev/null || echo "UNKNOWN")
    [ "$RT_STATUS" = "READY" ] && break
    case "$RT_STATUS" in
        CREATE_FAILED|UPDATE_FAILED|DELETING)
            echo -e "  ${RED}ERROR: Runtime status is $RT_STATUS${NC}"
            exit 1 ;;
    esac
    printf "\r  Runtime: %-12s (%2ds)" "$RT_STATUS" $((i*10))
    sleep 10
done
echo ""

if [ "$RT_STATUS" != "READY" ]; then
    echo -e "  ${RED}ERROR: Runtime did not become READY within 10 minutes (status: $RT_STATUS)${NC}"
    echo -e "  ${YELLOW}      6a 를 재실행하지 마세요 — Runtime 이 중복 생성됩니다.${NC}"
    echo -e "  ${YELLOW}      Do NOT re-run 6a; it would create a duplicate runtime.${NC}"
    exit 1
fi
echo -e "  ${GREEN}Runtime: READY${NC}"

EP_STATUS=$(aws bedrock-agentcore-control list-agent-runtime-endpoints \
    --agent-runtime-id "$RT_ID" --region "$REGION" \
    --query "runtimeEndpoints[?name=='DEFAULT'].status | [0]" --output text 2>/dev/null || echo "None")
if [ "$EP_STATUS" = "READY" ]; then
    echo -e "  ${GREEN}Endpoint DEFAULT: READY${NC}"
else
    echo -e "  ${YELLOW}WARN: DEFAULT endpoint status is '$EP_STATUS' — AI 호출이 실패할 수 있습니다.${NC}"
fi
EP_ID="DEFAULT"

# -- Summary -------------------------------------------------------------------
echo ""
echo -e "${GREEN}=================================================================${NC}"
echo -e "${GREEN}   Step 6a Complete: AgentCore Runtime configured${NC}"
echo -e "${GREEN}=================================================================${NC}"
echo ""
echo "  Runtime ID:   $RT_ID"
echo "  Runtime ARN:  $RT_ARN"
echo "  Endpoint:     $EP_ID (앱이 qualifier=DEFAULT 로 호출)"
echo "  ECR Image:    ${ECR_URI}:latest (arm64)"
echo ""
echo "  Next: bash scripts/06b-setup-agentcore-gateway.sh"
echo ""
