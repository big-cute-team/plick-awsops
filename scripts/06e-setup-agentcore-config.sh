#!/bin/bash
set -e
################################################################################
#                                                                              #
#   Step 6e: AgentCore 설정 적용 / Apply AgentCore Configuration               #
#                                                                              #
#   현재 계정의 AgentCore 리소스 ID를 config와 agent.py에 자동 설정합니다.      #
#   Auto-configures this account's AgentCore resource IDs.                     #
#                                                                              #
#   설정 대상 / Configures:                                                     #
#     - data/config.json: agentRuntimeArn, codeInterpreterName (gitignored)   #
#     - agent.py: 8 Gateway URLs (git 추적 대상 — 커밋 + Docker 재빌드 필요)   #
#                                                                              #
#   실행 조건 / Prerequisites:                                                  #
#     - Step 6a (Runtime), 6b (Gateways), 6d (Code Interpreter) 완료          #
#     - Step 3 이후 재빌드 필요 (npm run build)                                #
#                                                                              #
################################################################################

# -- 색상 / Colors ------------------------------------------------------------
GREEN='\033[0;32m'; RED='\033[0;31m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; NC='\033[0m'

# 배포/설치 상호 배제 — CI/CD 배포와 겹치면 .next 가 깨진다.
# Mutual exclusion with the CI/CD deploy; overlapping runs corrupt .next.
source "$(cd "$(dirname "$0")" && pwd)/lib/deploy-lock.sh"
acquire_deploy_lock "6e-config" || exit 1
BOLD='\033[1m'
WORK_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REGION="${AWS_DEFAULT_REGION:-ap-northeast-2}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo "unknown")

echo ""
echo -e "${CYAN}=================================================================${NC}"
echo -e "${CYAN}   Step 6e: AgentCore 설정 적용 / Apply Configuration${NC}"
echo -e "${CYAN}=================================================================${NC}"
echo ""
echo "  리전 / Region:  $REGION"
echo "  계정 / Account: $ACCOUNT_ID"
echo ""

###############################################################################
#  [1/4] 리소스 ID 조회 / Discover Resource IDs                                #
###############################################################################
echo -e "${CYAN}[1/4] AgentCore 리소스 조회 / Discovering resources...${NC}"

# Runtime ID 조회 / Get Runtime ID
RUNTIME_ID=$(aws bedrock-agentcore-control list-agent-runtimes --region "$REGION" --output json 2>/dev/null | \
    python3 -c "import json,sys;rts=json.load(sys.stdin);items=[v for k,v in rts.items() if isinstance(v,list)];print(items[0][0]['agentRuntimeId'] if items and items[0] else '')" 2>/dev/null || echo "")
if [ -z "$RUNTIME_ID" ]; then
    echo -e "${RED}오류: AgentCore Runtime을 찾을 수 없습니다. 06a를 먼저 실행하세요.${NC}"
    echo -e "${RED}ERROR: Runtime not found. Run 06a first.${NC}"
    exit 1
fi
RUNTIME_ARN="arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT_ID}:runtime/${RUNTIME_ID}"
echo "  Runtime:          $RUNTIME_ID"

# Code Interpreter ID 조회 / Get Code Interpreter ID
CI_ID=$(aws bedrock-agentcore-control list-code-interpreters --region "$REGION" --output json 2>/dev/null | \
    python3 -c "import json,sys;d=json.load(sys.stdin);cis=d.get('codeInterpreterSummaries',[]);print(cis[0]['codeInterpreterId'] if cis else '')" 2>/dev/null || echo "")
if [ -z "$CI_ID" ]; then
    echo -e "${YELLOW}경고: Code Interpreter를 찾을 수 없습니다 (선택 사항)${NC}"
    CI_ID="NONE"
fi
echo "  Code Interpreter: $CI_ID"

# Gateway IDs 조회 / Get Gateway IDs
echo "  Gateways:"
declare -A GW_MAP
GATEWAYS_JSON=$(aws bedrock-agentcore-control list-gateways --region "$REGION" --output json 2>/dev/null)

for GW_KEY in network container iac data security monitoring cost ops; do
    GW_NAME="awsops-${GW_KEY}-gateway"
    # 정확한 이름 매칭 (awsops-{key}-gateway) / Exact name match
    GW_ID=$(echo "$GATEWAYS_JSON" | python3 -c "import json,sys;gws=json.load(sys.stdin).get('items',[]);print(next((g['gatewayId'] for g in gws if g.get('name','')=='awsops-${GW_KEY}-gateway'), ''))" 2>/dev/null || echo "")
    if [ -n "$GW_ID" ]; then
        GW_MAP[$GW_KEY]="$GW_ID"
        GW_URL="https://${GW_ID}.gateway.bedrock-agentcore.${REGION}.amazonaws.com/mcp"
        echo "    ${GW_KEY}: $GW_ID"
    else
        echo -e "    ${GW_KEY}: ${YELLOW}없음 / not found${NC}"
    fi
done

###############################################################################
#  [2/4] data/config.json 업데이트 / Update data/config.json                    #
###############################################################################
echo ""
echo -e "${CYAN}[2/4] data/config.json 업데이트 / Updating data/config.json...${NC}"

CONFIG_FILE="$WORK_DIR/data/config.json"

# route.ts 는 이 값들을 런타임에 data/config.json 에서 읽는다(getAgentRuntimeArn 참조).
# 예전에는 여기서 route.ts 의 상수를 sed 로 덮어썼는데, route.ts 는 git 추적 대상이라
# 다음 배포의 `git reset --hard origin/main` 에 그대로 지워졌다. config.json 은
# .gitignore 에 있어 배포를 넘어 살아남는다.
# route.ts reads these from data/config.json at runtime (see getAgentRuntimeArn). This
# step used to sed the constants into route.ts, but that file is tracked and the next
# deploy's `git reset --hard origin/main` wiped it. config.json is gitignored and survives.
mkdir -p "$(dirname "$CONFIG_FILE")"
[ -f "$CONFIG_FILE" ] || echo '{}' > "$CONFIG_FILE"

python3 - "$CONFIG_FILE" "$RUNTIME_ARN" "$CI_ID" <<'PY'
import json, sys
path, runtime_arn, ci_id = sys.argv[1], sys.argv[2], sys.argv[3]
cfg = json.load(open(path))
cfg['agentRuntimeArn'] = runtime_arn
if ci_id and ci_id != 'NONE':
    cfg['codeInterpreterName'] = ci_id
json.dump(cfg, open(path, 'w'), indent=2, ensure_ascii=False)
PY

echo "  ✓ agentRuntimeArn = ${RUNTIME_ARN}"
[ "$CI_ID" != "NONE" ] && echo "  ✓ codeInterpreterName = ${CI_ID}"
echo "  ✓ 기록 위치 / written to: ${CONFIG_FILE}"

###############################################################################
#  [3/4] agent.py 업데이트 / Update agent.py                                   #
###############################################################################
echo ""
echo -e "${CYAN}[3/4] agent.py 업데이트 / Updating agent.py...${NC}"

AGENT_FILE="$WORK_DIR/agent/agent.py"
if [ ! -f "$AGENT_FILE" ]; then
    echo -e "${RED}오류: agent.py를 찾을 수 없습니다 / agent.py not found${NC}"
    exit 1
fi

# 백업 / Backup
cp "$AGENT_FILE" "${AGENT_FILE}.bak"

# 각 Gateway URL 업데이트 / Update each Gateway URL
for GW_KEY in network container iac data security monitoring cost ops; do
    GW_ID="${GW_MAP[$GW_KEY]}"
    if [ -n "$GW_ID" ]; then
        NEW_URL="https://${GW_ID}.gateway.bedrock-agentcore.${REGION}.amazonaws.com/mcp"
        # 해당 키의 URL 라인을 찾아서 교체 / Find and replace the URL for this key
        python3 -c "
import re
with open('${AGENT_FILE}', 'r') as f:
    content = f.read()
# '\"${GW_KEY}\"' 키의 URL을 새 URL로 교체 / Replace URL for this key
pattern = r'(\"${GW_KEY}\":\s*\")https://[^\"]+(\",?)'
replacement = r'\g<1>${NEW_URL}\g<2>'
content = re.sub(pattern, replacement, content)
with open('${AGENT_FILE}', 'w') as f:
    f.write(content)
"
        echo "  ✓ ${GW_KEY}: ${GW_ID}"
    fi
done

###############################################################################
#  [4/4] 재빌드 + 재시작 / Rebuild + Restart                                    #
###############################################################################
echo ""
echo -e "${CYAN}[4/4] 재빌드 및 재시작 / Rebuilding and restarting...${NC}"

cd "$WORK_DIR"
echo "  빌드 중... / Building..."
npm run build 2>&1 | tail -5

# systemd 유닛(Step 14)이 있으면 그쪽으로 재시작한다. fuser -k 로 포트를 죽이고
# nohup 으로 새로 띄우면 Restart=always 가 즉시 또 하나를 올려 3000 포트를 두고 경합한다.
# Restart through systemd when the unit exists: killing the port and re-launching with
# nohup makes Restart=always spawn a competing process on port 3000.
if [ -f /etc/systemd/system/awsops.service ]; then
    sudo systemctl restart awsops
    sleep 5
else
    command -v fuser &>/dev/null && fuser -k 3000/tcp 2>/dev/null || true
    sleep 2
    nohup npm run start > /tmp/awsops-server.log 2>&1 &
    sleep 3
fi

# 확인 / Verify — 이 배포판은 루트(/)에서 서빙한다. 업스트림 경로(/awsops)는 404 다.
# This fork serves at the root; the upstream /awsops path would 404 here.
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/ 2>/dev/null || echo "000")
echo "  서버 상태 / Server: HTTP $HTTP_CODE"

###############################################################################
#  요약 / Summary                                                               #
###############################################################################
echo ""
echo -e "${GREEN}=================================================================${NC}"
echo -e "${GREEN}   Step 6e 완료: AgentCore 설정 적용됨 / Configuration Applied${NC}"
echo -e "${GREEN}=================================================================${NC}"
echo ""
echo "  계정 / Account:     $ACCOUNT_ID"
echo "  리전 / Region:      $REGION"
echo "  Runtime:            $RUNTIME_ID"
echo "  Code Interpreter:   $CI_ID"
echo ""
echo "  Gateways:"
for GW_KEY in network container iac data security monitoring cost ops; do
    GW_ID="${GW_MAP[$GW_KEY]}"
    [ -n "$GW_ID" ] && echo "    ${GW_KEY}: ${GW_ID}"
done
echo ""
echo "  변경된 것 / Changed:"
echo "    - data/config.json  (agentRuntimeArn, codeInterpreterName) — gitignore 대상, 배포에도 유지됨"
echo "    - agent/agent.py    (8 Gateway URLs) + agent.py.bak"
echo ""
echo -e "  ${YELLOW}주의: agent.py 는 git 추적 대상입니다.${NC}"
echo -e "  ${YELLOW}  이 수정은 다음 배포의 'git reset --hard' 에 지워집니다. 커밋하세요:${NC}"
echo "    git add agent/agent.py && git commit -m 'Point agent.py at this account's gateways'"
echo -e "  ${YELLOW}  또한 agent.py 는 Docker 이미지에 구워지므로, 반영하려면 재빌드가 필요합니다:${NC}"
echo "    bash scripts/06a-setup-agentcore-runtime.sh   # 이미지 재빌드 + Runtime 갱신"
echo ""
echo -e "  ${BOLD}AI 채팅 테스트 / Test AI Chat:${NC}"
echo "    브라우저에서 /ai 페이지 접속 / Open /ai in the browser"
echo ""
