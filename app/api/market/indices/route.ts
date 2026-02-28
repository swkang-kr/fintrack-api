/**
 * GET /api/market/indices
 * KOSPI, KOSDAQ, S&P500, NASDAQ 지수 조회
 * 5분 캐시 (Vercel Edge Cache)
 */
import { NextResponse } from 'next/server';

const CHART_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';

const YF_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  Accept: 'application/json',
};

export interface MarketIndexData {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
}

const INDICES = [
  { symbol: '^KS11', name: 'KOSPI'  },
  { symbol: '^KQ11', name: 'KOSDAQ' },
  { symbol: '^GSPC', name: 'S&P500' },
  { symbol: '^IXIC', name: 'NASDAQ' },
];

async function fetchIndex(symbol: string): Promise<MarketIndexData | null> {
  try {
    const url = `${CHART_BASE}/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
    const res = await fetch(url, {
      headers: YF_HEADERS,
      next: { revalidate: 300 }, // 5분 캐시
    });
    if (!res.ok) return null;

    const json = await res.json();
    const meta = json?.chart?.result?.[0]?.meta;
    if (!meta || meta.regularMarketPrice == null) return null;

    const price: number = meta.regularMarketPrice;
    const prevClose: number = meta.chartPreviousClose ?? meta.previousClose ?? price;
    const change = price - prevClose;

    return {
      symbol,
      name: INDICES.find((i) => i.symbol === symbol)?.name ?? symbol,
      price: Math.round(price * 100) / 100,
      change: Math.round(change * 100) / 100,
      changePercent: Math.round((change / prevClose) * 10000) / 100,
    };
  } catch {
    return null;
  }
}

export async function GET() {
  const results = await Promise.all(INDICES.map((idx) => fetchIndex(idx.symbol)));

  const indices = results.filter((r): r is MarketIndexData => r !== null);

  return NextResponse.json(
    { indices },
    { headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=60' } }
  );
}
