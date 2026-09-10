#!/bin/bash
# ============================================================================
# AWSops - Step 6f: AgentCore Memory 설정
# AWSops - Step 6f: AgentCore Memory Setup
#
#   AgentCore Memory Store를 생성하여 AI 대화 이력을 영구 저장합니다.
#   Creates AgentCore Memory Store for persistent AI conversation history.
#
#   사전 요구사항:
#     - Step 6a (Runtime) 완료
#     - AWS CLI v2 + bedrock-agentcore 명령 사용 가능
#
# ============================================================================
set -e

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

REGION="${AWS_DEFAULT_REGION:-ap-northeast-2}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text 2>/dev/null)
MEMORY_NAME="awsops_memory"  # 하이픈 불가, 언더스코어만 / No hyphens, underscores only
# 스크립트 위치 기준으로 잡는다. 예전에는 ${HOME}/awsops 로 고정돼 있어, 체크아웃
# 디렉토리 이름이 다르면(예: plick-awsops) 존재하지도 않는 경로에 config 를 새로 만들고
# 정작 앱이 읽는 config 는 건드리지 않았다.
# Resolve from the script's own location. This used to be pinned to ${HOME}/awsops, so a
# checkout under any other name (e.g. plick-awsops) had the config written to a path
# nothing reads, leaving the real one untouched.
WORK_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG_FILE="${WORK_DIR}/data/config.json"

echo -e "${CYAN}=================================================================${NC}"
echo -e "${CYAN}  AWSops - Step 6f: AgentCore Memory 설정${NC}"
echo -e "${CYAN}=================================================================${NC}"
echo ""
echo -e "  계정 / Account:  ${GREEN}${ACCOUNT_ID}${NC}"
echo -e "  리전 / Region:   ${GREEN}${REGION}${NC}"
echo -e "  Memory 이름:     ${GREEN}${MEMORY_NAME}${NC}"
echo ""

# -- [1/3] Memory Store 생성 / Create Memory Store ----------------------------
echo -e "${CYAN}[1/3] Memory Store 생성 중...${NC}"

# 기존 Memory 확인 / Check existing memory
# 응답의 식별자 필드는 'id' 다. 예전 파서는 'memoryId'/'memory_id' 만 찾아 항상 빈 값을
# 얻었고, 그 결과 이미 있는 Memory 를 못 찾고 새로 만들려 했다.
# 또한 list-memories 응답에는 name 이 없어 이름으로 거를 수 없으므로, id 접두사로 찾는다.
# The identifier field is 'id'. The old parser only looked for 'memoryId'/'memory_id' and
# always came back empty, so an existing memory was never found. list-memories also omits
# 'name', so match on the id prefix instead.
EXISTING=$(aws bedrock-agentcore-control list-memories \
  --region "$REGION" --output json 2>/dev/null || echo '{"memories":[]}')
MEMORY_ID=$(echo "$EXISTING" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for m in data.get('memories', data.get('items', [])):
    mid = m.get('id') or m.get('memoryId') or m.get('memory_id') or ''
    if mid.startswith('${MEMORY_NAME}'):
        print(mid)
        break
" 2>/dev/null)

if [ -n "$MEMORY_ID" ] && [ "$MEMORY_ID" != "" ]; then
    echo -e "  ${GREEN}기존 Memory 발견: ${MEMORY_ID}${NC}"
else
    echo -e "  ${YELLOW}새 Memory Store 생성 중...${NC}"
    # 이름: 하이픈 불가, 언더스코어만 / Name: no hyphens, underscores only
    # eventExpiryDuration: 최대 365일 / max 365 days
    CREATE_RESULT=$(aws bedrock-agentcore-control create-memory \
      --name "$MEMORY_NAME" \
      --description "AWSops AI Assistant conversation history" \
      --event-expiry-duration 365 \
      --tags Project=awsops,Environment=dev,ManagedBy=script \
      --region "$REGION" \
      --output json 2>&1)

    # create-memory 는 {"memory": {"id": ...}} 형태로 반환한다. 예전 파서는 최상위에서
    # 'memoryId' 를 찾다가 빈 값을 얻고, 실제로는 Memory 가 만들어졌는데도 "리전 미지원"
    # 이라며 local-fallback 으로 넘어갔다. 서울 리전은 Memory API 를 지원한다.
    # create-memory returns {"memory": {"id": ...}}. The old parser looked for a top-level
    # 'memoryId', got nothing, and fell back to local storage claiming the region was
    # unsupported — while the memory had in fact been created. Seoul does support it.
    MEMORY_ID=$(echo "$CREATE_RESULT" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
m = data.get('memory', data)
print(m.get('id') or m.get('memoryId') or m.get('memory_id') or '')
" 2>/dev/null)

    if [ -n "$MEMORY_ID" ]; then
        echo -e "  ${GREEN}Memory 생성 요청됨: ${MEMORY_ID}${NC}"
    else
        echo -e "  ${RED}Memory 생성 실패${NC}"
        echo "  $CREATE_RESULT"
        echo ""
        echo -e "  ${YELLOW}로컬 파일 기반 메모리로 폴백합니다 (data/memory/).${NC}"
        MEMORY_ID="local-fallback"
    fi
fi

# 생성 직후에는 CREATING 이다. ACTIVE 가 될 때까지 기다린다 — 기다리지 않고 상태만 보고
# 실패로 단정하면 멀쩡한 Memory 를 두고 local-fallback 으로 새는 일이 생긴다.
# A freshly created memory is CREATING; wait for ACTIVE rather than judging it failed.
if [ "$MEMORY_ID" != "local-fallback" ]; then
    for i in $(seq 1 30); do
        MEM_STATUS=$(aws bedrock-agentcore-control get-memory --memory-id "$MEMORY_ID" \
            --region "$REGION" --query 'memory.status' --output text 2>/dev/null || echo "UNKNOWN")
        [ "$MEM_STATUS" = "ACTIVE" ] && break
        case "$MEM_STATUS" in
            FAILED|DELETING)
                echo -e "  ${RED}Memory 상태: $MEM_STATUS — local-fallback 으로 전환${NC}"
                MEMORY_ID="local-fallback"; break ;;
        esac
        printf "\r  Memory: %-10s (%2ds)" "$MEM_STATUS" $((i*5))
        sleep 5
    done
    echo ""
    [ "$MEMORY_ID" != "local-fallback" ] && echo -e "  ${GREEN}Memory: ACTIVE${NC}"
fi

# -- [2/3] config.json에 Memory ID 저장 / Save to config -----------------------
echo ""
echo -e "${CYAN}[2/3] config.json에 Memory ID 저장 중...${NC}"

mkdir -p "$(dirname "$CONFIG_FILE")"
if [ -f "$CONFIG_FILE" ]; then
    python3 -c "
import json
cfg = json.load(open('${CONFIG_FILE}'))
cfg['memoryId'] = '${MEMORY_ID}'
cfg['memoryName'] = '${MEMORY_NAME}'
json.dump(cfg, open('${CONFIG_FILE}', 'w'), indent=2)
print(json.dumps(cfg, indent=2))
"
else
    echo "{\"costEnabled\":true,\"memoryId\":\"${MEMORY_ID}\",\"memoryName\":\"${MEMORY_NAME}\"}" > "$CONFIG_FILE"
    cat "$CONFIG_FILE"
fi

# -- [3/3] 검증 / Verify -------------------------------------------------------
echo ""
echo -e "${CYAN}[3/3] Memory Store 검증 중...${NC}"

if [ "$MEMORY_ID" = "local-fallback" ]; then
    echo -e "  ${YELLOW}로컬 파일 기반 메모리 사용 (data/memory/)${NC}"
    mkdir -p "${WORK_DIR}/data/memory"
else
    VERIFY=$(aws bedrock-agentcore-control get-memory \
      --memory-id "$MEMORY_ID" \
      --region "$REGION" --output json 2>/dev/null || echo '{}')
    STATUS=$(echo "$VERIFY" | python3 -c "import json,sys;print(json.load(sys.stdin).get('status','UNKNOWN'))" 2>/dev/null)
    echo -e "  Memory ID: ${GREEN}${MEMORY_ID}${NC}"
    echo -e "  Status:    ${GREEN}${STATUS}${NC}"
fi

# -- 완료 / Done ---------------------------------------------------------------
echo ""
echo -e "${GREEN}=================================================================${NC}"
echo -e "${GREEN}  Step 6e 완료 / Step 6e Complete${NC}"
echo -e "${GREEN}=================================================================${NC}"
echo ""
echo -e "  Memory ID: ${CYAN}${MEMORY_ID}${NC}"
echo -e "  Config:    ${CYAN}${CONFIG_FILE}${NC}"
echo ""
echo -e "  ${YELLOW}다음 단계: npm run build && 서버 재시작${NC}"
echo -e "  ${YELLOW}Next: npm run build && restart server${NC}"
