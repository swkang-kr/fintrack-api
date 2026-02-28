import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { fetchQuotes } from '@/lib/stocks/yahooFinance';

function toYahooTicker(ticker: string, market: string): string {
  if (market === 'KOSPI') return `${ticker}.KS`;
  if (market === 'KOSDAQ') return `${ticker}.KQ`;
  return ticker;
}

// Vercel Cron: 매일 15:00 UTC (한국 자정) 포트폴리오 스냅샷 저장
export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get('authorization');
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createServiceClient();

  // 모든 포트폴리오 조회
  const { data: portfolios, error: portErr } = await supabase
    .from('portfolios')
    .select('id, user_id');

  if (portErr) {
    return NextResponse.json({ error: portErr.message }, { status: 500 });
  }

  let saved = 0;
  let skipped = 0;
  const today = new Date().toISOString().split('T')[0];

  for (const portfolio of portfolios ?? []) {
    // 포트폴리오의 종목 조회
    const { data: holdings } = await supabase
      .from('holdings')
      .select('quantity, avg_price, currency, ticker, market')
      .eq('portfolio_id', portfolio.id);

    if (!holdings || holdings.length === 0) continue;

    // Yahoo Finance 티커 변환
    const yahooTickers = holdings.map((h) => toYahooTicker(h.ticker, h.market));

    // 현재가 조회 (실패 시 avg_price 사용)
    let quotes: Record<string, { price: number }> = {};
    try {
      quotes = await fetchQuotes(yahooTickers);
    } catch {
      // 조회 실패 시 avg_price로 fallback
    }

    // 현재 평가금액 계산 (KRW 기준, USD는 1350 고정)
    const USD_KRW = 1350;
    let totalValue = 0;
    let totalCost = 0;

    for (let i = 0; i < holdings.length; i++) {
      const h = holdings[i];
      const yt = yahooTickers[i];
      const mult = h.currency === 'USD' ? USD_KRW : 1;
      const currentPrice = quotes[yt]?.price ?? h.avg_price;

      totalValue += currentPrice * h.quantity * mult;
      totalCost += h.avg_price * h.quantity * mult;
    }

    const totalPnl = totalValue - totalCost;
    const pnlPercent = totalCost > 0 ? (totalPnl / totalCost) * 100 : 0;

    const { error: upsertErr } = await supabase
      .from('portfolio_snapshots')
      .upsert({
        portfolio_id: portfolio.id,
        user_id: portfolio.user_id,
        total_value: Math.round(totalValue),
        total_cost: Math.round(totalCost),
        total_pnl: Math.round(totalPnl),
        pnl_percent: parseFloat(pnlPercent.toFixed(4)),
        snapshot_date: today,
      }, { onConflict: 'portfolio_id,snapshot_date' });

    if (upsertErr) {
      skipped++;
    } else {
      saved++;
    }
  }

  return NextResponse.json({ ok: true, saved, skipped });
}
