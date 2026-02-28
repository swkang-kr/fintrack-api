import { NextRequest, NextResponse } from 'next/server';
import { searchStocks } from '@/lib/stocks/yahooFinance';

/**
 * GET /api/stocks/search
 * 종목 검색 (국내·해외 통합)
 *
 * Query:
 *   q=삼성전자   (검색어, 한글·영문 모두 가능)
 *
 * Response:
 * {
 *   results: [
 *     { yahooTicker, ticker, name, market, currency }
 *   ]
 * }
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const q = searchParams.get('q')?.trim();

  if (!q || q.length < 1) {
    return NextResponse.json({ error: '검색어를 입력해주세요.' }, { status: 400 });
  }

  try {
    const results = await searchStocks(q);
    return NextResponse.json({ results });
  } catch (error) {
    console.error('[stocks/search] failed:', error);
    return NextResponse.json({ error: '종목 검색에 실패했습니다.' }, { status: 500 });
  }
}
