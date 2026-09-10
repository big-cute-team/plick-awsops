#!/bin/bash
set -e
################################################################################
#                                                                              #
#   AWSops Dashboard - Step 14: Next.js systemd unit (awsops.service)         #
#                                                                              #
#   03-build-deploy.sh 와 09-start-all.sh 는 서버를 `nohup ... &` 로 띄운다.    #
#   이 프로세스는 SSM 세션이 끊기거나 EC2가 재부팅되면 조용히 사라지고, 아무도  #
#   되살리지 않는다. 증상은 고약하다 — ALB 타겟이 unhealthy 가 되어 사이트가    #
#   502를 뱉는데, Steampipe 는 멀쩡히 살아있어 원인이 눈에 안 띈다.             #
#                                                                              #
#   09-start-all.sh 는 이미 awsops.service 가 있으면 그걸 쓰도록 되어 있지만,   #
#   정작 유닛을 만들어주는 스크립트가 없었다. 이 스크립트가 그 구멍을 메운다.   #
#                                                                              #
#   03-build-deploy.sh and 09-start-all.sh start the server with `nohup ... &`, #
#   which dies with the SSM session or a reboot and nothing restarts it.        #
#   09-start-all.sh already prefers awsops.service when present — this script   #
#   is what actually creates that unit.                                         #
#                                                                              #
#   생성 (재실행 안전) / Creates (idempotent):                                  #
#     - /etc/systemd/system/awsops.service        (Restart=always, enable)      #
#     - /etc/sudoers.d/awsops-deploy              (CI/CD 재시작 권한)           #
#                                                                              #
#   이후 서버는 systemctl 로만 관리한다 / Manage only via systemctl:            #
#     sudo systemctl {start|stop|restart|status} awsops                         #
#                                                                              #
################################################################################

GREEN='\033[0;32m'; RED='\033[0;31m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; NC='\033[0m'
WORK_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE_USER="${SERVICE_USER:-ec2-user}"
APP_PORT="${APP_PORT:-3000}"
NODE_BIN="$(command -v node || echo /usr/bin/node)"

echo ""
echo -e "${CYAN}=================================================================${NC}"
echo -e "${CYAN}   Step 14: Register Next.js as a systemd service${NC}"
echo -e "${CYAN}=================================================================${NC}"
echo ""

if [ "$(id -u)" -ne 0 ]; then
    echo -e "${RED}root 권한이 필요합니다 / Must run as root:${NC}"
    echo "  sudo bash scripts/14-setup-app-systemd.sh"
    exit 1
fi

# -- [1/4] 사전 점검 / Pre-flight ------------------------------------------------
echo -e "${CYAN}[1/4] 사전 점검 / Pre-flight checks...${NC}"

NEXT_BIN="$WORK_DIR/node_modules/.bin/next"
if [ ! -x "$NEXT_BIN" ]; then
    echo -e "${RED}오류: $NEXT_BIN 이 없습니다. 먼저 npm install 을 실행하세요.${NC}"
    echo -e "${RED}ERROR: $NEXT_BIN missing. Run npm install first.${NC}"
    exit 1
fi
if [ ! -f "$WORK_DIR/.next/BUILD_ID" ]; then
    echo -e "${YELLOW}경고: .next/BUILD_ID 가 없습니다. 먼저 npm run build 가 필요합니다.${NC}"
    echo -e "${YELLOW}WARNING: no production build yet — run npm run build.${NC}"
fi
echo "  Work dir: $WORK_DIR"
echo "  Node:     $NODE_BIN ($($NODE_BIN -v 2>/dev/null))"
echo "  User:     $SERVICE_USER"
echo "  Port:     $APP_PORT"

# -- [2/4] awsops.service --------------------------------------------------------
# npm 래퍼(npm run start)를 거치지 않고 next 를 직접 실행한다. npm 이 중간에 끼면
# systemd 의 시그널이 자식까지 깔끔하게 전달되지 않아 stop/restart 가 지저분해진다.
# Exec next directly rather than through `npm run start`: the npm wrapper swallows
# signals, which makes systemd stop/restart messy.
echo ""
echo -e "${CYAN}[2/4] awsops.service 설치...${NC}"

cat > /etc/systemd/system/awsops.service <<EOF
[Unit]
Description=AWSops Dashboard (Next.js production server, port ${APP_PORT})
Documentation=https://github.com/big-cute-team/plick-awsops
After=network-online.target steampipe.service
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${WORK_DIR}
Environment=HOME=/home/${SERVICE_USER}
Environment=NODE_ENV=production
Environment=PORT=${APP_PORT}
ExecStart=${NODE_BIN} ${NEXT_BIN} start -p ${APP_PORT}
Restart=always
RestartSec=5
TimeoutStopSec=30
StandardOutput=append:/var/log/awsops.log
StandardError=append:/var/log/awsops.log

[Install]
WantedBy=multi-user.target
EOF
echo -e "  ${GREEN}/etc/systemd/system/awsops.service 작성${NC}"

install -m 644 -o "$SERVICE_USER" -g "$SERVICE_USER" /dev/null /var/log/awsops.log 2>/dev/null || true

# -- [3/4] CI/CD 재시작 권한 / sudoers -------------------------------------------
# GitHub Actions 가 SSM 으로 배포할 때 ec2-user 로 재시작해야 한다.
# The CI/CD deploy runs as ec2-user over SSM and needs to restart the unit.
echo ""
echo -e "${CYAN}[3/4] 배포용 sudoers 항목...${NC}"
cat > /etc/sudoers.d/awsops-deploy <<EOF
${SERVICE_USER} ALL=(root) NOPASSWD: /usr/bin/systemctl restart awsops, /usr/bin/systemctl status awsops, /usr/bin/systemctl is-active awsops
EOF
chmod 440 /etc/sudoers.d/awsops-deploy
visudo -cf /etc/sudoers.d/awsops-deploy >/dev/null && echo -e "  ${GREEN}/etc/sudoers.d/awsops-deploy 검증 통과${NC}"

# -- [4/4] 기동 / Enable + start --------------------------------------------------
echo ""
echo -e "${CYAN}[4/4] 서비스 기동...${NC}"

# nohup 으로 떠 있던 기존 프로세스를 정리한 뒤 systemd 로 넘긴다.
# Clear any nohup'd server still holding the port before handing over to systemd.
fuser -k "${APP_PORT}/tcp" 2>/dev/null || true
sleep 1

systemctl daemon-reload
systemctl enable awsops.service >/dev/null 2>&1
systemctl restart awsops.service
sleep 5

if systemctl is-active --quiet awsops.service; then
    echo -e "  ${GREEN}awsops.service: active (enabled)${NC}"
else
    echo -e "${RED}오류: 서비스가 뜨지 않았습니다 / ERROR: service failed to start${NC}"
    journalctl -u awsops.service -n 20 --no-pager
    exit 1
fi

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${APP_PORT}/" 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "200" ]; then
    echo -e "  ${GREEN}http://localhost:${APP_PORT}/ → HTTP 200${NC}"
else
    echo -e "  ${YELLOW}http://localhost:${APP_PORT}/ → HTTP ${HTTP_CODE} (빌드 여부를 확인하세요)${NC}"
fi

echo ""
echo -e "${GREEN}=================================================================${NC}"
echo -e "${GREEN}   Step 14 완료 / Complete${NC}"
echo -e "${GREEN}=================================================================${NC}"
echo ""
echo "  로그 / Logs:     tail -f /var/log/awsops.log"
echo "  상태 / Status:   systemctl status awsops"
echo "  재시작 /Restart: sudo systemctl restart awsops"
echo ""
echo -e "  ${YELLOW}주의: 이후 nohup 으로 직접 띄우지 마세요. 포트가 충돌합니다.${NC}"
echo -e "  ${YELLOW}Note: do not start the server with nohup any more — it will fight systemd.${NC}"
echo ""
