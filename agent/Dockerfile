FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends libpq-dev gcc && rm -rf /var/lib/apt/lists/*

# mcp 는 1.x 로 고정한다. streamable_http_sigv4.py 는 mcp 1.x 의 StreamableHTTP 내부를
# 가져다 SigV4 서명을 얹은 파일이라, 2.x 에서 제거된 streamablehttp_client 와
# GetSessionIdCallback 에 의존한다. 고정 없이 두면 pip 이 최신(2.1.1)을 설치하고
# 컨테이너가 ImportError 로 기동조차 못 한다 — 그런데 AgentCore 는 "An error occurred
# when starting the runtime" 만 보여줘서 원인을 찾기 어렵다.
# strands-agents 가 mcp<2.2,>=1.23.0 을 허용하므로 1.x 고정과 충돌하지 않는다.
#
# Pin mcp to 1.x: streamable_http_sigv4.py vendors mcp 1.x StreamableHTTP internals to add
# SigV4 signing, and depends on streamablehttp_client and GetSessionIdCallback, both gone
# in 2.x. Unpinned, pip installs the newest allowed (2.1.1) and the container dies with an
# ImportError that surfaces only as "An error occurred when starting the runtime".
# strands-agents allows mcp<2.2,>=1.23.0, so a 1.x pin does not conflict.
RUN pip install --no-cache-dir \
    strands-agents \
    strands-agents-tools \
    boto3 \
    psycopg2-binary \
    "bedrock-agentcore<=0.1.5" \
    "mcp>=1.23,<2" \
    httpx \
    httpx-sse \
    aws-requests-auth

COPY streamable_http_sigv4.py .
COPY agent.py .

EXPOSE 8080

CMD ["python", "agent.py"]
