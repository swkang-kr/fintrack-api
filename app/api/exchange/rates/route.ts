import { NextResponse } from 'next/server';
import { fetchCurrentRates } from '@/lib/exchange/frankfurter';
import { fetchBokRates } from '@/lib/exchange/bok';

/**
 * GET /api/exchange/rates
 * 현재 환율 조회 (USD, EUR, JPY, CNY → KRW)
 *
 * Response:
 * {
 *   rates: { USD: 1380.50, EUR: 1490.20, JPY: 9.2340, CNY: 190.30 },
 *   updatedAt: "2026-02-27",
 *   source: "bok" | "frankfurter"
 * }
 */
export async function GET() {
  // BOK API key가 있으면 공식 환율 우선 사용
  if (process.env.BOK_API_KEY) {
    try {
      const data = await fetchBokRates();
      return NextResponse.json({ ...data, source: 'bok' });
    } catch {
      // BOK 실패 시 Frankfurter로 폴백
    }
  }

  try {
    const data = await fetchCurrentRates();
    return NextResponse.json({ ...data, source: 'frankfurter' });
  } catch (error) {
    console.error('[exchange/rates] fetch failed:', error);
    return NextResponse.json(
      { error: '환율 데이터를 가져오는데 실패했습니다.' },
      { status: 500 }
    );
  }
}
