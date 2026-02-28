/**
 * Yahoo Finance 비공식 API 클라이언트
 * 해외·국내 주식 시세 조회 (국내는 ticker.KS / ticker.KQ 형식)
 */

import { searchKoreanStocksLocal } from './koreanStocks';

const CHART_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';
const SEARCH_BASE = 'https://query1.finance.yahoo.com/v1/finance/search';

const YF_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  Accept: 'application/json',
};

// ── 타입 ─────────────────────────────────────────────────

export interface StockQuote {
  yahooTicker: string;
  price: number;
  previousClose: number;
  change: number;
  changePercent: number;
  currency: string;
  name: string;
}

export interface StockSearchResult {
  yahooTicker: string;  // '005930.KS', 'AAPL'
  ticker: string;       // '005930', 'AAPL'  (display)
  name: string;
  market: string;       // 'KOSPI', 'NASDAQ', …
  currency: string;
}

// ── 시세 조회 ─────────────────────────────────────────────

async function fetchSingleQuote(
  yahooTicker: string
): Promise<StockQuote | null> {
  try {
    const url = `${CHART_BASE}/${encodeURIComponent(yahooTicker)}?interval=1d&range=1d`;
    const res = await fetch(url, {
      headers: YF_HEADERS,
      next: { revalidate: 60 }, // 1분 캐시
    });
    if (!res.ok) return null;

    const json = await res.json();
    const meta = json?.chart?.result?.[0]?.meta;
    if (!meta || meta.regularMarketPrice == null) return null;

    const price: number = meta.regularMarketPrice;
    const previousClose: number =
      meta.chartPreviousClose ?? meta.previousClose ?? price;
    const change = price - previousClose;

    return {
      yahooTicker,
      price: round(price, 4),
      previousClose: round(previousClose, 4),
      change: round(change, 4),
      changePercent: round((change / previousClose) * 100, 2),
      currency: meta.currency ?? 'USD',
      name: meta.longName ?? meta.shortName ?? yahooTicker,
    };
  } catch {
    return null;
  }
}

/** 여러 야후 티커를 병렬 조회 */
export async function fetchQuotes(
  yahooTickers: string[]
): Promise<Record<string, StockQuote>> {
  const results = await Promise.all(
    yahooTickers.map((t) => fetchSingleQuote(t))
  );

  const map: Record<string, StockQuote> = {};
  results.forEach((q, i) => {
    if (q) map[yahooTickers[i]] = q;
  });
  return map;
}

// ── 종목 검색 ─────────────────────────────────────────────

export async function searchStocks(
  query: string
): Promise<StockSearchResult[]> {
  // 한글 포함 시 로컬 정적 DB 검색
  if (/[\uAC00-\uD7A3]/.test(query)) {
    return searchKoreanStocks(query);
  }
  return searchYahooStocks(query);
}

/** 한글 종목명 검색 — 로컬 정적 DB (Yahoo Finance가 한글 미지원) */
function searchKoreanStocks(query: string): StockSearchResult[] {
  const matches = searchKoreanStocksLocal(query);
  return matches.map(({ ticker, name, market }) => ({
    yahooTicker: market === 'KOSDAQ' ? `${ticker}.KQ` : `${ticker}.KS`,
    ticker,
    name,
    market,
    currency: 'KRW',
  }));
}

/** 영문·티커 검색 — Yahoo Finance Search API */
async function searchYahooStocks(query: string): Promise<StockSearchResult[]> {
  const url = `${SEARCH_BASE}?q=${encodeURIComponent(query)}&newsCount=0&quotesCount=10&enableFuzzyQuery=false`;
  const res = await fetch(url, {
    headers: YF_HEADERS,
    next: { revalidate: 60 },
  });
  if (!res.ok) return [];

  const json = await res.json();
  const quotes: Array<Record<string, string>> = json?.quotes ?? [];

  return quotes
    .filter((q) => q.quoteType === 'EQUITY')
    .map((q) => {
      const yahooTicker: string = q.symbol;
      const ticker = stripExchangeSuffix(yahooTicker);
      const market = resolveMarket(q.exchDisp ?? '', yahooTicker);
      return {
        yahooTicker,
        ticker,
        name: q.shortname ?? q.longname ?? ticker,
        market,
        currency: marketToCurrency(market),
      };
    });
}

// ── 유틸 ─────────────────────────────────────────────────

function stripExchangeSuffix(symbol: string): string {
  return symbol.replace(/\.(KS|KQ|T|HK|SS|SZ)$/, '');
}

function resolveMarket(exchDisp: string, symbol: string): string {
  if (symbol.endsWith('.KS')) return 'KOSPI';
  if (symbol.endsWith('.KQ')) return 'KOSDAQ';
  if (exchDisp.includes('NASDAQ')) return 'NASDAQ';
  if (exchDisp.includes('NYSE')) return 'NYSE';
  return exchDisp || 'UNKNOWN';
}

function marketToCurrency(market: string): string {
  if (market === 'KOSPI' || market === 'KOSDAQ') return 'KRW';
  return 'USD';
}

export function toYahooTicker(ticker: string, market: string): string {
  if (market === 'KOSPI') return `${ticker}.KS`;
  if (market === 'KOSDAQ') return `${ticker}.KQ`;
  return ticker;
}

function round(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}
