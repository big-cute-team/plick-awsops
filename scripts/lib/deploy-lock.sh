#!/bin/bash
# 배포 상호 배제 / Deploy mutual exclusion
#
# CI/CD 배포(git reset --hard + npm ci + npm run build)와 EC2에서 사람이 직접 돌리는
# 설치 스크립트가 같은 체크아웃을 쓴다. 둘이 겹치면 git reset 이 진행 중인 작업을 지우고
# 빌드 두 개가 .next 를 서로 덮어써 산출물이 깨진다 — 2026-09-10 에 대시보드가
# 이 방식으로 내려갔다(.next/BUILD_ID 소실 → 서비스 크래시 루프).
#
# The CI/CD deploy and the hands-on setup scripts share one checkout. When they overlap,
# git reset --hard discards in-flight edits and two concurrent builds clobber .next. That
# is exactly how the dashboard went down on 2026-09-10 (missing .next/BUILD_ID → crash loop).
#
# 사용법 / Usage:
#   source "$(dirname "$0")/lib/deploy-lock.sh"
#   acquire_deploy_lock "6c-tools"     # 잡을 때까지 대기 (기본 20분)
#   ...작업...
#   release_deploy_lock                # trap 으로도 자동 해제됨

DEPLOY_LOCK_FILE="${DEPLOY_LOCK_FILE:-/var/tmp/awsops-deploy.lock}"
DEPLOY_LOCK_WAIT="${DEPLOY_LOCK_WAIT:-1200}"   # 초 / seconds

acquire_deploy_lock() {
    local owner="${1:-unknown}"
    local waited=0

    while ! mkdir "$DEPLOY_LOCK_FILE" 2>/dev/null; do
        local holder="(unknown)"
        [ -f "$DEPLOY_LOCK_FILE/owner" ] && holder="$(cat "$DEPLOY_LOCK_FILE/owner" 2>/dev/null)"

        # 죽은 프로세스가 남긴 락은 회수한다 / Reclaim a lock left by a dead process.
        if [ -f "$DEPLOY_LOCK_FILE/pid" ]; then
            local pid; pid="$(cat "$DEPLOY_LOCK_FILE/pid" 2>/dev/null)"
            if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then
                echo "  [lock] 죽은 락 회수 / reclaiming stale lock from pid $pid ($holder)"
                rm -rf "$DEPLOY_LOCK_FILE"
                continue
            fi
        fi

        if [ "$waited" -ge "$DEPLOY_LOCK_WAIT" ]; then
            echo "  [lock] 대기 시간 초과 — '$holder' 가 아직 잡고 있습니다." >&2
            echo "  [lock] timed out waiting for '$holder'" >&2
            return 1
        fi
        [ "$waited" = 0 ] && echo "  [lock] '$holder' 가 배포 중입니다. 대기 / waiting for '$holder'..."
        sleep 10
        waited=$((waited + 10))
    done

    echo "$owner" > "$DEPLOY_LOCK_FILE/owner"
    echo "$$"     > "$DEPLOY_LOCK_FILE/pid"
    date -u +%FT%TZ > "$DEPLOY_LOCK_FILE/since"
    trap release_deploy_lock EXIT INT TERM
    return 0
}

release_deploy_lock() {
    [ -d "$DEPLOY_LOCK_FILE" ] && rm -rf "$DEPLOY_LOCK_FILE"
    return 0
}
