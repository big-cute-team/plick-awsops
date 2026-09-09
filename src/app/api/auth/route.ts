// Logout API — ALB Cognito 세션 쿠키를 만료시키고 Cognito 로그아웃 URL을 반환
// Logout API — expires the ALB Cognito session cookies and returns the Cognito logout URL
//
// 인증은 ALB의 authenticate-cognito 액션이 담당한다. 앱 쿠키만 지우면 ALB가
// 이미 인증된 세션으로 계속 통과시키므로, ALB 세션 쿠키(AWSELBAuthSessionCookie-N)를
// 함께 만료시키고 Cognito 세션까지 끊어야 실제 로그아웃이 된다.
// Auth is handled by the ALB authenticate-cognito action. Clearing the app cookie
// alone leaves the ALB session valid, so we also expire AWSELBAuthSessionCookie-N
// and end the Cognito session via its logout endpoint.
import { NextRequest, NextResponse } from 'next/server';
import { getConfig } from '@/lib/app-config';

// ALB는 세션 쿠키를 여러 조각으로 나눠 저장할 수 있다 (-0, -1, ...)
// ALB may shard the session cookie across multiple parts (-0, -1, ...)
const ALB_COOKIE_SHARDS = 4;

export async function POST(request: NextRequest) {
  const config = getConfig();
  const appUrl = config.appUrl || `${request.nextUrl.origin}/`;

  // Cognito 설정이 있으면 호스티드 UI 로그아웃으로 보낸다 / Use hosted UI logout when configured
  let logoutUrl = appUrl;
  if (config.cognitoDomain && config.cognitoClientId) {
    const domain = config.cognitoDomain.replace(/^https?:\/\//, '');
    logoutUrl = `https://${domain}/logout`
      + `?client_id=${encodeURIComponent(config.cognitoClientId)}`
      + `&logout_uri=${encodeURIComponent(appUrl)}`;
  }

  const response = NextResponse.json({ ok: true, logoutUrl });

  const expired = ['awsops_token=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0'];
  for (let i = 0; i < ALB_COOKIE_SHARDS; i++) {
    expired.push(`AWSELBAuthSessionCookie-${i}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`);
  }
  for (const cookie of expired) {
    response.headers.append('Set-Cookie', cookie);
  }

  return response;
}
