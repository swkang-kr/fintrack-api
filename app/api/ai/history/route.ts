/**
 * GET /api/ai/history
 * 사용자의 AI 분석 히스토리 조회 (최근 30건)
 */
import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient, getUserFromRequest } from '@/lib/supabase/server';

export async function GET(request: NextRequest) {
  const user = await getUserFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from('ai_reports')
    .select('id, created_at, report_data')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(30);

  if (error) return NextResponse.json({ error: 'DB error' }, { status: 500 });

  return NextResponse.json({ history: data ?? [] });
}
