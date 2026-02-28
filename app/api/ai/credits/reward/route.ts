import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient, getUserFromRequest } from '@/lib/supabase/server';

const MAX_BONUS_PER_DAY = 15; // 5 ads × 3 credits each
const CREDITS_PER_AD = 3;

/** 오늘(UTC) 날짜 문자열 YYYY-MM-DD */
function todayUTC(): string {
  return new Date().toISOString().split('T')[0];
}

/** POST /api/ai/credits/reward — 광고 시청 후 +3 크레딧 지급 */
export async function POST(request: NextRequest) {
  // 1. JWT 인증
  const user = await getUserFromRequest(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createServiceClient();
  const today = todayUTC();

  // 2. 오늘 누적 보너스 조회
  const { data: existing } = await supabase
    .from('ai_credits')
    .select('bonus')
    .eq('user_id', user.id)
    .eq('date', today)
    .single();

  const currentBonus = existing?.bonus ?? 0;

  // 3. 일일 한도 초과 확인
  if (currentBonus >= MAX_BONUS_PER_DAY) {
    return NextResponse.json(
      { error: '일일 최대 광고 보상에 도달했습니다', bonusToday: currentBonus },
      { status: 400 }
    );
  }

  // 4. 새 보너스 계산 (최대 15 cap)
  const newBonus = Math.min(currentBonus + CREDITS_PER_AD, MAX_BONUS_PER_DAY);

  // 5. Upsert ai_credits
  const { error: upsertError } = await supabase
    .from('ai_credits')
    .upsert(
      { user_id: user.id, date: today, bonus: newBonus },
      { onConflict: 'user_id,date' }
    );

  if (upsertError) {
    console.error('[ai/credits/reward] upsert error:', upsertError);
    return NextResponse.json({ error: 'DB error' }, { status: 500 });
  }

  return NextResponse.json({
    bonusToday: newBonus,
    message: `+${CREDITS_PER_AD} 크레딧이 지급되었습니다!`,
  });
}
