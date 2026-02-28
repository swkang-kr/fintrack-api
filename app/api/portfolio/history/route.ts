import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient, getUserFromRequest } from '@/lib/supabase/server';

/** GET /api/portfolio/history — 포트폴리오 스냅샷 히스토리 */
export async function GET(request: NextRequest) {
  const user = await getUserFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const portfolioId = searchParams.get('portfolioId');
  const range = searchParams.get('range') ?? '1M';

  if (!portfolioId) {
    return NextResponse.json({ error: 'portfolioId required' }, { status: 400 });
  }

  const supabase = createServiceClient();

  // 소유권 확인
  const { data: portfolio } = await supabase
    .from('portfolios')
    .select('id')
    .eq('id', portfolioId)
    .eq('user_id', user.id)
    .single();

  if (!portfolio) {
    return NextResponse.json({ error: 'Portfolio not found' }, { status: 404 });
  }

  const days = range === '1W' ? 7 : range === '3M' ? 90 : range === '6M' ? 180 : 30;
  const since = new Date(Date.now() - days * 86_400_000).toISOString().split('T')[0];

  const { data: snapshots, error } = await supabase
    .from('portfolio_snapshots')
    .select('snapshot_date, total_value, total_cost, pnl_percent')
    .eq('portfolio_id', portfolioId)
    .gte('snapshot_date', since)
    .order('snapshot_date', { ascending: true });

  if (error) {
    return NextResponse.json({ error: 'DB error' }, { status: 500 });
  }

  return NextResponse.json({ snapshots: snapshots ?? [] });
}
