/**
 * GET /api/stocks/fundamentals?ticker=AAPL (또는 005930.KS)
 * 기업 기초 정보: PER, EPS, 52주 고저, 목표주가, 시가총액, 배당수익률, 베타
 *
 * 국내 주식 (.KS/.KQ): KIS 공식 데이터 (PER, EPS, PBR, BPS, 시가총액, 외국인 보유율 포함)
 * 해외 주식: Yahoo Finance
 */
import { NextRequest, NextResponse } from 'next/server';
import { fetchKisDomesticFundamentals } from '@/lib/stocks/kis';

const YF_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  Accept: 'application/json',
};

export interface StockFundamentals {
  ticker: string;
  source: 'kis' | 'yahoo';
  trailingPE: number | null;
  forwardPE: number | null;
  epsTrailing: number | null;
  fiftyTwoWeekHigh: number | null;
  fiftyTwoWeekLow: number | null;
  marketCap: number | null;
  dividendYield: number | null;
  beta: number | null;
  // 국내 주식 추가 필드 (KIS 전용)
  pbr: number | null;
  bps: number | null;
  foreignHoldingRate: number | null;
  todayOpen: number | null;
  todayHigh: number | null;
  todayLow: number | null;
  volume: number | null;
  // 해외 주식 추가 필드 (Yahoo 전용)
  targetMeanPrice: number | null;
  targetHighPrice: number | null;
  targetLowPrice: number | null;
  analystCount: number | null;
  recommendationKey: string | null;
}

export async function GET(req: NextRequest) {
  const ticker = req.nextUrl.searchParams.get('ticker');
  if (!ticker) {
    return NextResponse.json({ error: 'ticker required' }, { status: 400 });
  }

  // 국내 주식 (.KS / .KQ) → KIS 우선
  const isDomestic = ticker.endsWith('.KS') || ticker.endsWith('.KQ');
  const cleanTicker = isDomestic ? ticker.slice(0, -3) : ticker;

  // ── KIS (국내) ────────────────────────────────────────────
  if (isDomestic && process.env.KIS_APP_KEY && process.env.KIS_APP_SECRET) {
    try {
      const kis = await fetchKisDomesticFundamentals(cleanTicker);
      if (kis) {
        const fundamentals: StockFundamentals = {
          ticker,
          source: 'kis',
          trailingPE:         kis.trailingPE,
          forwardPE:          null,              // KIS 미제공
          epsTrailing:        kis.epsTrailing,
          fiftyTwoWeekHigh:   kis.fiftyTwoWeekHigh,
          fiftyTwoWeekLow:    kis.fiftyTwoWeekLow,
          marketCap:          kis.marketCap,
          dividendYield:      null,              // 별도 API 필요
          beta:               null,              // KIS 미제공
          pbr:                kis.pbr,
          bps:                kis.bps,
          foreignHoldingRate: kis.foreignHoldingRate,
          todayOpen:          kis.todayOpen,
          todayHigh:          kis.todayHigh,
          todayLow:           kis.todayLow,
          volume:             kis.volume,
          targetMeanPrice:    null,
          targetHighPrice:    null,
          targetLowPrice:     null,
          analystCount:       null,
          recommendationKey:  null,
        };
        return NextResponse.json(
          { fundamentals },
          { headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=300' } }
        );
      }
    } catch (err) {
      console.error('[fundamentals] KIS failed, falling back to Yahoo:', err);
    }
  }

  // ── Yahoo Finance (해외 또는 KIS fallback) ────────────────
  try {
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(ticker)}&fields=trailingPE,forwardPE,epsTrailingTwelveMonths,fiftyTwoWeekHigh,fiftyTwoWeekLow,marketCap,dividendYield,beta,targetMeanPrice,targetHighPrice,targetLowPrice,numberOfAnalystOpinions,recommendationKey`;

    const res = await fetch(url, { headers: YF_HEADERS, next: { revalidate: 3600 } });
    if (!res.ok) throw new Error(`Yahoo Finance error: ${res.status}`);

    const json = await res.json();
    const q = json?.quoteResponse?.result?.[0];
    if (!q) return NextResponse.json({ error: 'not found' }, { status: 404 });

    const fundamentals: StockFundamentals = {
      ticker,
      source: 'yahoo',
      trailingPE:         q.trailingPE            ?? null,
      forwardPE:          q.forwardPE             ?? null,
      epsTrailing:        q.epsTrailingTwelveMonths ?? null,
      fiftyTwoWeekHigh:   q.fiftyTwoWeekHigh      ?? null,
      fiftyTwoWeekLow:    q.fiftyTwoWeekLow       ?? null,
      marketCap:          q.marketCap             ?? null,
      dividendYield:      q.dividendYield != null ? q.dividendYield * 100 : null,
      beta:               q.beta                  ?? null,
      pbr:                null,
      bps:                null,
      foreignHoldingRate: null,
      todayOpen:          null,
      todayHigh:          null,
      todayLow:           null,
      volume:             null,
      targetMeanPrice:    q.targetMeanPrice        ?? null,
      targetHighPrice:    q.targetHighPrice        ?? null,
      targetLowPrice:     q.targetLowPrice         ?? null,
      analystCount:       q.numberOfAnalystOpinions ?? null,
      recommendationKey:  q.recommendationKey      ?? null,
    };

    return NextResponse.json(
      { fundamentals },
      { headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=300' } }
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'fetch failed' },
      { status: 500 }
    );
  }
}
