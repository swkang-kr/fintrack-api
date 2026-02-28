/**
 * 한국은행 경제통계시스템 (ECOS) API 클라이언트
 * 통계표: 036Y001 (외환/환율)
 * 공식 환율이므로 Frankfurter보다 KRW 정확도가 높음
 * BOK_API_KEY 환경변수가 있을 때만 사용
 */

const BASE_URL = 'https://ecos.bok.or.kr/api/StatisticSearch';

// 036Y001 항목 코드 (매매기준율)
const ITEM_CODES = {
  USD: '0000001', // 대미달러
  JPY: '0000002', // 엔화 (100엔당)
  EUR: '0000003', // 유로화
  CNY: '0000053', // 위안화
} as const;

type SupportedCurrency = keyof typeof ITEM_CODES;

interface BokRow {
  STAT_CODE: string;
  STAT_NAME: string;
  ITEM_CODE1: string;
  ITEM_NAME1: string;
  DATA_VALUE: string;
  TIME: string; // YYYYMMDD
}

interface BokResponse {
  StatisticSearch?: {
    list_total_count: number;
    row: BokRow[];
  };
}

function buildUrl(
  apiKey: string,
  startDate: string,
  endDate: string,
  itemCode: string
): string {
  // 날짜 형식: YYYYMMDD
  return `${BASE_URL}/${apiKey}/json/kr/1/1/036Y001/DD/${startDate}/${endDate}/${itemCode}`;
}

function toEcosDate(date: Date): string {
  return date.toISOString().split('T')[0].replace(/-/g, '');
}

async function fetchSingleRate(
  apiKey: string,
  currency: SupportedCurrency
): Promise<number | null> {
  const today = toEcosDate(new Date());
  // BOK는 주말에 데이터 없으므로 최근 7일 범위로 조회
  const weekAgo = toEcosDate(new Date(Date.now() - 7 * 86_400_000));
  const url = buildUrl(apiKey, weekAgo, today, ITEM_CODES[currency]);

  const res = await fetch(url, { next: { revalidate: 300 } });
  if (!res.ok) return null;

  const data: BokResponse = await res.json();
  const rows = data.StatisticSearch?.row;
  if (!rows || rows.length === 0) return null;

  // 가장 최근 데이터 사용 (마지막 row)
  const lastRow = rows[rows.length - 1];
  const value = parseFloat(lastRow.DATA_VALUE);
  if (isNaN(value)) return null;

  // JPY는 100엔당 환율이므로 1엔 환율로 변환
  return currency === 'JPY' ? value / 100 : value;
}

export async function fetchBokRates(): Promise<{
  rates: { USD: number; EUR: number; JPY: number; CNY: number };
  updatedAt: string;
}> {
  const apiKey = process.env.BOK_API_KEY;
  if (!apiKey) throw new Error('BOK_API_KEY not set');

  const [USD, JPY, EUR, CNY] = await Promise.all([
    fetchSingleRate(apiKey, 'USD'),
    fetchSingleRate(apiKey, 'JPY'),
    fetchSingleRate(apiKey, 'EUR'),
    fetchSingleRate(apiKey, 'CNY'),
  ]);

  if (!USD || !JPY || !EUR || !CNY) {
    throw new Error('BOK API: 일부 환율 데이터 조회 실패');
  }

  return {
    rates: {
      USD: round(USD, 2),
      EUR: round(EUR, 2),
      JPY: round(JPY, 4),
      CNY: round(CNY, 2),
    },
    updatedAt: new Date().toISOString().split('T')[0],
  };
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
