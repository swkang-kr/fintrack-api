/**
 * 한국투자증권 KIS OpenAPI 클라이언트
 * 국내 주식 (KOSPI/KOSDAQ) 실시간 시세 + 펀더멘털 조회
 *
 * Rate limit 대응:
 *   - KIS 무료 플랜: 최대 20 req/sec (per TR)
 *   - 이 모듈: 최대 10 req/sec (MIN_INTERVAL_MS=100) — 보수적으로 절반만 사용
 *   - EGW00201(속도 초과) 응답 시 최대 3회 지수 백오프 재시도
 */

import type { StockQuote } from './yahooFinance';

export interface KisFundamentals {
  ticker: string;
  trailingPE: number | null;        // per
  epsTrailing: number | null;       // eps
  pbr: number | null;               // pbr
  bps: number | null;               // bps
  fiftyTwoWeekHigh: number | null;  // w52_hgpr
  fiftyTwoWeekLow: number | null;   // w52_lwpr
  marketCap: number | null;         // hts_avls × 1억 (원 단위)
  foreignHoldingRate: number | null;// hts_frgn_ehrt (%)
  todayOpen: number | null;         // stck_oprc
  todayHigh: number | null;         // stck_hgpr
  todayLow: number | null;          // stck_lwpr
  volume: number | null;            // acml_vol
}

const KIS_BASE = 'https://openapi.koreainvestment.com:9443';

// KIS가 rate limit 응답 시 반환하는 msg_cd
const RATE_LIMIT_CODE = 'EGW00201';

// ── Rate limiter (request queue) ─────────────────────────
// 모든 KIS API 호출은 enqueue()를 통해 직렬 처리됨
// 이전 호출 완료 후 MIN_INTERVAL_MS 이상 경과해야 다음 호출 실행
const MIN_INTERVAL_MS = 100; // 10 req/sec (KIS 한도 20/sec의 절반)
const MAX_RETRIES = 3;

let lastCallAt = 0;
let queueTail: Promise<void> = Promise.resolve();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * KIS API 호출을 직렬 큐에 등록
 * 각 호출은 이전 호출 완료 + MIN_INTERVAL_MS 후에 실행됨
 */
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const result = queueTail.then(async () => {
    const gap = lastCallAt + MIN_INTERVAL_MS - Date.now();
    if (gap > 0) await sleep(gap);
    lastCallAt = Date.now();
    return fn();
  });
  // 에러가 나도 큐가 멈추지 않도록 noop으로 꼬리 유지
  queueTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

// ── 토큰 캐시 + mutex ─────────────────────────────────────
// KIS는 앱키 당 토큰 1개만 유효 — 동시 발급 시 이전 토큰 무효화됨
let tokenCache: { token: string; expiresAt: number } | null = null;
let tokenFetchPromise: Promise<string> | null = null;

async function getAccessToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }

  // 발급 중이면 같은 Promise 공유 (중복 발급 방지)
  if (tokenFetchPromise) return tokenFetchPromise;

  tokenFetchPromise = (async () => {
    try {
      const appKey = process.env.KIS_APP_KEY;
      const appSecret = process.env.KIS_APP_SECRET;
      if (!appKey || !appSecret) throw new Error('KIS 키 미설정');

      const res = await fetch(`${KIS_BASE}/oauth2/tokenP`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'client_credentials',
          appkey: appKey,
          appsecret: appSecret,
        }),
      });

      if (!res.ok) throw new Error(`KIS 토큰 발급 실패: ${res.status}`);

      const data = await res.json();
      if (!data.access_token) throw new Error('KIS 토큰 없음');

      tokenCache = {
        token: data.access_token,
        expiresAt: Date.now() + (Number(data.expires_in) - 60) * 1000,
      };

      return tokenCache.token;
    } finally {
      tokenFetchPromise = null;
    }
  })();

  return tokenFetchPromise;
}

// ── 공통 inquire-price 단일 호출 ─────────────────────────

type OutputMap = Record<string, string>;

/** rate limit이면 'RATE_LIMITED' 반환, 그 외 에러는 null 반환 */
async function callInquirePriceOnce(
  ticker: string,
): Promise<OutputMap | 'RATE_LIMITED' | null> {
  const appKey = process.env.KIS_APP_KEY!;
  const appSecret = process.env.KIS_APP_SECRET!;
  const token = await getAccessToken();

  const url =
    `${KIS_BASE}/uapi/domestic-stock/v1/quotations/inquire-price` +
    `?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${ticker}`;

  const res = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      appkey: appKey,
      appsecret: appSecret,
      tr_id: 'FHKST01010100',
    },
  });

  if (!res.ok) return null;

  const data = await res.json();

  if (data.rt_cd !== '0') {
    if (data.msg_cd === RATE_LIMIT_CODE) return 'RATE_LIMITED';
    console.warn(`[KIS] ${ticker} rt_cd=${data.rt_cd} msg_cd=${data.msg_cd} msg=${data.msg1}`);
    return null;
  }

  return data.output ?? null;
}

// ── Rate limit 재시도 포함 inquire-price ─────────────────

/**
 * 큐 + 재시도 적용 inquire-price 호출
 * EGW00201(속도 초과) 시 지수 백오프로 최대 MAX_RETRIES회 재시도
 */
async function callInquirePrice(ticker: string): Promise<OutputMap | null> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let result: OutputMap | 'RATE_LIMITED' | null;

    try {
      result = await enqueue(() => callInquirePriceOnce(ticker));
    } catch (err) {
      console.error(`[KIS] ${ticker} 호출 예외:`, err);
      return null;
    }

    if (result !== 'RATE_LIMITED') return result;

    if (attempt < MAX_RETRIES) {
      const delay = 500 * 2 ** attempt; // 500ms → 1000ms → 2000ms
      console.warn(
        `[KIS] ${ticker} rate limited — ${delay}ms 후 재시도 (${attempt + 1}/${MAX_RETRIES})`,
      );
      await sleep(delay);
    } else {
      console.error(`[KIS] ${ticker} rate limit 재시도 ${MAX_RETRIES}회 초과, 포기`);
    }
  }

  return null;
}

// ── 유틸 ─────────────────────────────────────────────────

function safeFloat(v: unknown): number | null {
  const n = parseFloat(String(v));
  return isFinite(n) ? n : null;
}

// ── 국내 주식 현재가 조회 ─────────────────────────────────

/**
 * @param ticker  clean 티커 (예: '005930', '035720')
 * @param suffix  '.KS' | '.KQ'
 */
export async function fetchKisDomesticQuote(
  ticker: string,
  suffix: string,
): Promise<StockQuote | null> {
  const o = await callInquirePrice(ticker);
  if (!o) return null;

  const price = safeFloat(o.stck_prpr);
  if (!price || price <= 0) return null;

  return {
    yahooTicker: `${ticker}${suffix}`,
    price,
    previousClose: safeFloat(o.stck_sdpr) ?? price,
    change: safeFloat(o.prdy_vrss) ?? 0,
    changePercent: safeFloat(o.prdy_ctrt) ?? 0,
    currency: 'KRW',
    name: ticker, // KIS inquire-price에 종목명 없음 — 앱 DB 저장값 사용
  };
}

/**
 * 여러 국내 티커 조회 (큐에 의해 자동 직렬화)
 */
export async function fetchKisDomesticQuotes(
  entries: Array<{ ticker: string; suffix: string }>,
): Promise<Record<string, StockQuote>> {
  const results = await Promise.all(
    entries.map(({ ticker, suffix }) => fetchKisDomesticQuote(ticker, suffix)),
  );

  const map: Record<string, StockQuote> = {};
  results.forEach((q) => {
    if (q) map[q.yahooTicker] = q;
  });
  return map;
}

// ── 국내 주식 펀더멘털 조회 ───────────────────────────────

/**
 * inquire-price 응답에서 펀더멘털 추출
 * (PER, EPS, PBR, BPS, 52주 고저, 시가총액, 외국인 보유율, 당일 OHLV)
 */
export async function fetchKisDomesticFundamentals(
  ticker: string,
): Promise<KisFundamentals | null> {
  const o = await callInquirePrice(ticker);
  if (!o) return null;

  const avlsAeok = safeFloat(o.hts_avls);

  return {
    ticker,
    trailingPE:         safeFloat(o.per),
    epsTrailing:        safeFloat(o.eps),
    pbr:                safeFloat(o.pbr),
    bps:                safeFloat(o.bps),
    fiftyTwoWeekHigh:   safeFloat(o.w52_hgpr),
    fiftyTwoWeekLow:    safeFloat(o.w52_lwpr),
    marketCap:          avlsAeok != null ? avlsAeok * 1_0000_0000 : null,
    foreignHoldingRate: safeFloat(o.hts_frgn_ehrt),
    todayOpen:          safeFloat(o.stck_oprc),
    todayHigh:          safeFloat(o.stck_hgpr),
    todayLow:           safeFloat(o.stck_lwpr),
    volume:             safeFloat(o.acml_vol),
  };
}
