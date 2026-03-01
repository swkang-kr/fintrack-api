/**
 * GET /api/stocks/fundamentals?ticker=AAPL (또는 005930.KS)
 * 기업 기초 정보: PER, EPS, 52주 고저, 목표주가, 시가총액, 배당수익률, 베타
 *
 * 국내 주식 (.KS/.KQ): KIS 공식 데이터 (PER, EPS, PBR, BPS, 시가총액, 외국인 보유율 포함)
 * 해외 주식: Yahoo Finance
 */
import { NextRequest, NextResponse } from 'next/server';
import { fetchKisDomesticFundamentals } from '@/lib/stocks/kis';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ── Yahoo Finance crumb 캐시 (함수 인스턴스 수준) ─────────
let yfCrumbCache: { crumb: string; cookie: string; expiry: number } | null = null;

async function getYFCrumb(): Promise<{ crumb: string; cookie: string }> {
  if (yfCrumbCache && Date.now() < yfCrumbCache.expiry) {
    return yfCrumbCache;
  }

  // Step 1: Yahoo Finance 방문으로 쿠키 획득
  const pageRes = await fetch('https://finance.yahoo.com/', {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
    redirect: 'follow',
  });
  const rawCookie = pageRes.headers.get('set-cookie') ?? '';
  const cookie = rawCookie.split(/,(?=\s*\w+=)/).map((c) => c.split(';')[0].trim()).join('; ');

  // Step 2: crumb 발급
  const crumbRes = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
    headers: { 'User-Agent': UA, Cookie: cookie },
  });
  const crumb = (await crumbRes.text()).trim();

  yfCrumbCache = { crumb, cookie, expiry: Date.now() + 25 * 60 * 1000 };
  return yfCrumbCache;
}

const YF_CHART_HEADERS = {
  'User-Agent': UA,
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

  // ── Yahoo Finance (crumb 인증 → quoteSummary, chart fallback) ──
  try {
    // chart 엔드포인트로 52주 고저 / 거래량 등 기본 데이터 획득 (crumb 불필요)
    const chartUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`;
    const chartRes = await fetch(chartUrl, { headers: YF_CHART_HEADERS, next: { revalidate: 300 } });
    const chartMeta = chartRes.ok ? (await chartRes.json())?.chart?.result?.[0]?.meta ?? {} : {};

    // crumb 인증 후 quoteSummary로 PE/EPS/시가총액 등 획득
    let ks: Record<string, { raw?: number } | number | string | null> = {};
    let fd: Record<string, { raw?: number } | number | string | null> = {};
    let sd: Record<string, { raw?: number } | number | string | null> = {};

    try {
      const { crumb, cookie } = await getYFCrumb();
      const modules = 'defaultKeyStatistics,financialData,summaryDetail';
      const qsUrl = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=${modules}&crumb=${encodeURIComponent(crumb)}`;
      const qsRes = await fetch(qsUrl, {
        headers: { 'User-Agent': UA, Accept: 'application/json', Cookie: cookie },
        next: { revalidate: 3600 },
      });
      if (qsRes.ok) {
        const qsJson = await qsRes.json();
        const result = qsJson?.quoteSummary?.result?.[0];
        if (result) {
          ks = result.defaultKeyStatistics ?? {};
          fd = result.financialData ?? {};
          sd = result.summaryDetail ?? {};
        }
      }
    } catch {
      // quoteSummary 실패 시 chart 데이터만 사용
    }

    const raw = (obj: Record<string, { raw?: number } | number | string | null>, key: string): number | null => {
      const val = obj[key];
      if (val == null) return null;
      if (typeof val === 'object' && val !== null && 'raw' in val) return val.raw ?? null;
      if (typeof val === 'number') return val;
      return null;
    };

    if (!chartRes.ok && Object.keys(ks).length === 0) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }

    const fundamentals: StockFundamentals = {
      ticker,
      source: 'yahoo',
      trailingPE:         raw(ks, 'trailingPE'),
      forwardPE:          raw(ks, 'forwardPE'),
      epsTrailing:        raw(ks, 'trailingEps'),
      fiftyTwoWeekHigh:   raw(sd, 'fiftyTwoWeekHigh') ?? chartMeta.fiftyTwoWeekHigh ?? null,
      fiftyTwoWeekLow:    raw(sd, 'fiftyTwoWeekLow')  ?? chartMeta.fiftyTwoWeekLow  ?? null,
      marketCap:          raw(sd, 'marketCap'),
      dividendYield:      raw(sd, 'dividendYield') != null ? (raw(sd, 'dividendYield')! * 100) : null,
      beta:               raw(ks, 'beta'),
      pbr:                null,
      bps:                null,
      foreignHoldingRate: null,
      todayOpen:          chartMeta.regularMarketOpen   ?? null,
      todayHigh:          chartMeta.regularMarketDayHigh ?? null,
      todayLow:           chartMeta.regularMarketDayLow  ?? null,
      volume:             chartMeta.regularMarketVolume  ?? null,
      targetMeanPrice:    raw(fd, 'targetMeanPrice'),
      targetHighPrice:    raw(fd, 'targetHighPrice'),
      targetLowPrice:     raw(fd, 'targetLowPrice'),
      analystCount:       raw(fd, 'numberOfAnalystOpinions'),
      recommendationKey:  typeof fd.recommendationKey === 'string' ? fd.recommendationKey : null,
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
