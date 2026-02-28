const BASE_URL = 'https://api.frankfurter.app';

interface FrankfurterLatestResponse {
  amount: number;
  base: string;
  date: string;
  rates: Record<string, number>;
}

interface FrankfurterHistoryResponse {
  amount: number;
  base: string;
  start_date: string;
  end_date: string;
  rates: Record<string, Record<string, number>>;
}

export interface ExchangeRates {
  USD: number;
  EUR: number;
  JPY: number;
  CNY: number;
}

/**
 * USD 기준으로 KRW, EUR, JPY, CNY 조회 후 KRW 기준 환율로 변환
 * USD/KRW = rates.KRW
 * EUR/KRW = rates.KRW / rates.EUR
 * JPY/KRW  = rates.KRW / rates.JPY
 * CNY/KRW = rates.KRW / rates.CNY
 */
export async function fetchCurrentRates(): Promise<{
  rates: ExchangeRates;
  updatedAt: string;
}> {
  const res = await fetch(`${BASE_URL}/latest?from=USD&to=KRW,EUR,JPY,CNY`, {
    next: { revalidate: 300 }, // 5분 캐시
  });

  if (!res.ok) {
    throw new Error(`Frankfurter API error: ${res.status}`);
  }

  const data: FrankfurterLatestResponse = await res.json();
  const { KRW, EUR, JPY, CNY } = data.rates;

  return {
    rates: {
      USD: round(KRW, 2),
      EUR: round(KRW / EUR, 2),
      JPY: round(KRW / JPY, 4),
      CNY: round(KRW / CNY, 2),
    },
    updatedAt: data.date,
  };
}

type SupportedCurrency = 'USD' | 'EUR' | 'JPY' | 'CNY';

/**
 * 특정 통화/KRW 환율 히스토리 조회
 * Frankfurter는 USD 기준으로 받아서 크로스 레이트로 계산
 */
export async function fetchRateHistory(
  currency: SupportedCurrency,
  days: number
): Promise<Array<{ date: string; rate: number }>> {
  const endDate = toDateString(new Date());
  const startDate = toDateString(new Date(Date.now() - days * 86_400_000));

  const toSymbols = currency === 'USD' ? 'KRW' : `KRW,${currency}`;
  const url = `${BASE_URL}/${startDate}..${endDate}?from=USD&to=${toSymbols}`;

  const res = await fetch(url, {
    next: { revalidate: 3600 }, // 1시간 캐시
  });

  if (!res.ok) {
    throw new Error(`Frankfurter history API error: ${res.status}`);
  }

  const data: FrankfurterHistoryResponse = await res.json();
  const decimals = currency === 'JPY' ? 4 : 2;

  return Object.entries(data.rates)
    .map(([date, rates]) => {
      const rate =
        currency === 'USD'
          ? rates.KRW
          : rates.KRW / rates[currency];
      return { date, rate: round(rate, decimals) };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function toDateString(date: Date): string {
  return date.toISOString().split('T')[0];
}
