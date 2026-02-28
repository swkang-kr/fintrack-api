import { NextRequest, NextResponse } from 'next/server';
import { fetchQuotes, type StockQuote } from '@/lib/stocks/yahooFinance';
import { fetchKisDomesticQuotes } from '@/lib/stocks/kis';

/**
 * GET /api/stocks/quote
 * 주식 현재가 일괄 조회
 *
 * Query:
 *   tickers=005930.KS,AAPL,MSFT  (Yahoo Finance 형식, 콤마 구분)
 *
 * 국내 주식 (.KS/.KQ):  KIS 실시간 시세 우선 → 실패 시 Yahoo Finance fallback
 * 해외 주식 (그 외):    Yahoo Finance
 *
 * Response:
 * {
 *   quotes: {
 *     "005930.KS": { price, previousClose, change, changePercent, currency, name },
 *     "AAPL":      { ... }
 *   },
 *   sources: { "005930.KS": "kis", "AAPL": "yahoo" }
 * }
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const tickersParam = searchParams.get('tickers');

  if (!tickersParam?.trim()) {
    return NextResponse.json({ error: 'tickers 파라미터가 필요합니다.' }, { status: 400 });
  }

  const tickers = tickersParam
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 50);

  // ── 국내 / 해외 분리 ─────────────────────────────────────
  const domesticEntries: Array<{ ticker: string; suffix: string; yahooTicker: string }> = [];
  const overseasTickers: string[] = [];

  for (const yt of tickers) {
    if (yt.endsWith('.KS')) {
      domesticEntries.push({ ticker: yt.slice(0, -3), suffix: '.KS', yahooTicker: yt });
    } else if (yt.endsWith('.KQ')) {
      domesticEntries.push({ ticker: yt.slice(0, -3), suffix: '.KQ', yahooTicker: yt });
    } else {
      overseasTickers.push(yt);
    }
  }

  try {
    const quotes: Record<string, StockQuote> = {};
    const sources: Record<string, string> = {};

    // ── 국내: KIS 먼저, 실패한 종목은 Yahoo fallback ──────
    const kisNeeded = process.env.KIS_APP_KEY && process.env.KIS_APP_SECRET;
    let kisQuotes: Record<string, StockQuote> = {};

    if (domesticEntries.length > 0 && kisNeeded) {
      kisQuotes = await fetchKisDomesticQuotes(
        domesticEntries.map(({ ticker, suffix }) => ({ ticker, suffix }))
      );
    }

    // KIS 결과 반영, 누락된 건 Yahoo fallback 목록에 추가
    const yahooFallback: string[] = [];
    for (const { yahooTicker } of domesticEntries) {
      if (kisQuotes[yahooTicker]) {
        quotes[yahooTicker] = kisQuotes[yahooTicker];
        sources[yahooTicker] = 'kis';
      } else {
        yahooFallback.push(yahooTicker); // KIS 실패 → Yahoo 재시도
      }
    }

    // ── 해외 + fallback → Yahoo Finance ──────────────────
    const yahooTickers = [...overseasTickers, ...yahooFallback];
    if (yahooTickers.length > 0) {
      const yahooQuotes = await fetchQuotes(yahooTickers);
      for (const [yt, q] of Object.entries(yahooQuotes)) {
        quotes[yt] = q;
        sources[yt] = 'yahoo';
      }
    }

    return NextResponse.json({ quotes, sources });
  } catch (error) {
    console.error('[stocks/quote] fetch failed:', error);
    return NextResponse.json({ error: '주가 조회에 실패했습니다.' }, { status: 500 });
  }
}
