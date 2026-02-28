import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient, getUserFromRequest } from '@/lib/supabase/server';

/**
 * POST /api/alerts/register-token
 * 모바일 앱의 Expo Push Token을 DB에 등록 (upsert)
 *
 * Headers:
 *   Authorization: Bearer {supabase_access_token}
 *
 * Body:
 *   { token: "ExponentPushToken[xxx]", platform: "ios" | "android" }
 */
export async function POST(request: NextRequest) {
  const user = await getUserFromRequest(request);
  if (!user) {
    return NextResponse.json({ error: '인증이 필요합니다.' }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const { token, platform } = body ?? {};

  if (!token || !platform) {
    return NextResponse.json(
      { error: 'token과 platform이 필요합니다.' },
      { status: 400 }
    );
  }

  if (!['ios', 'android'].includes(platform)) {
    return NextResponse.json(
      { error: 'platform은 ios 또는 android여야 합니다.' },
      { status: 400 }
    );
  }

  try {
    const supabase = createServiceClient();

    // 같은 토큰이 이미 있으면 user_id 업데이트, 없으면 신규 삽입
    const { error } = await supabase.from('push_tokens').upsert(
      { user_id: user.id, token, platform },
      { onConflict: 'token' }
    );

    if (error) throw error;

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[register-token] error:', err);
    return NextResponse.json({ error: '토큰 등록에 실패했습니다.' }, { status: 500 });
  }
}
