import { NextRequest, NextResponse } from 'next/server';
import { fetchRateHistory } from '@/lib/exchange/frankfurter';

const VALID_CURRENCIES = ['USD', 'EUR', 'JPY', 'CNY'] as const;
type SupportedCurrency = (typeof VALID_CURRENCIES)[number];

/**
 * GET /api/exchange/history
 * 환율 히스토리 조회
 *
 * Query params:
 *   pair: "USD/KRW" | "EUR/KRW" | "JPY/KRW" | "CNY/KRW" (기본: USD/KRW)
 *   days: 1~365 (기본: 30)
 *
 * Response:
 * {
 *   pair: "USD/KRW",
 *   data: [{ date: "2026-01-28", rate: 1378.50 }, ...]
 * }
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;

  const pair = searchParams.get('pair') ?? 'USD/KRW';
  const daysParam = parseInt(searchParams.get('days') ?? '30', 10);
  const days = Math.min(Math.max(isNaN(daysParam) ? 30 : daysParam, 1), 365);

  const currency = pair.split('/')[0].toUpperCase() as SupportedCurrency;

  if (!VALID_CURRENCIES.includes(currency)) {
    return NextResponse.json(
      { error: `지원하지 않는 통화입니다. 사용 가능: ${VALID_CURRENCIES.join(', ')}` },
      { status: 400 }
    );
  }

  try {
    const data = await fetchRateHistory(currency, days);
    return NextResponse.json({ pair, data });
  } catch (error) {
    console.error('[exchange/history] fetch failed:', error);
    return NextResponse.json(
      { error: '환율 히스토리를 가져오는데 실패했습니다.' },
      { status: 500 }
    );
  }
}
