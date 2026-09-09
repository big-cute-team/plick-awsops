// JWT에서 사용자 정보 추출 — Cognito awsops_token 쿠키에서 디코딩
// Extract user info from JWT — decode from Cognito awsops_token cookie
// 서명 검증 없이 payload만 디코딩 (Lambda@Edge에서 이미 검증됨)
// Decode payload only without verification (already verified by Lambda@Edge)
import { NextRequest } from 'next/server';

export interface UserInfo {
  email: string;
  sub: string;    // Cognito user ID
}

const ANONYMOUS: UserInfo = { email: 'anonymous', sub: 'anonymous' };

// ALB authenticate-cognito는 검증된 사용자 클레임을 x-amzn-oidc-data 헤더로 전달
// ALB authenticate-cognito passes verified user claims via x-amzn-oidc-data header
function decodeJwtPayload(token: string): Record<string, string> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(
      Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8')
    );
  } catch {
    return null;
  }
}

export function getUserFromRequest(request: NextRequest): UserInfo {
  try {
    // 1순위: ALB 인증 헤더 (ALB에서 이미 서명 검증됨)
    const oidcData = request.headers.get('x-amzn-oidc-data');
    if (oidcData) {
      const claims = decodeJwtPayload(oidcData);
      if (claims) {
        return {
          email: claims.email || claims.username || claims.sub || 'unknown',
          sub: claims.sub || 'unknown',
        };
      }
    }

    // 2순위: 레거시 awsops_token 쿠키 (구 Lambda@Edge 방식)
    const cookieHeader = request.headers.get('cookie') || '';
    const cookies: Record<string, string> = {};
    cookieHeader.split(';').forEach(c => {
      const [k, v] = c.trim().split('=');
      if (k && v) cookies[k.trim()] = v.trim();
    });

    const token = cookies['awsops_token'];
    if (!token) return ANONYMOUS;

    // JWT는 header.payload.signature 형태 / JWT format: header.payload.signature
    const parts = token.split('.');
    if (parts.length !== 3) return ANONYMOUS;

    // Base64url 디코딩 / Base64url decode
    const payload = JSON.parse(
      Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8')
    );

    return {
      email: payload.email || payload['cognito:username'] || payload.sub || 'unknown',
      sub: payload.sub || 'unknown',
    };
  } catch {
    return ANONYMOUS;
  }
}
