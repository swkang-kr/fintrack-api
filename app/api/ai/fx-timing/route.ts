import Anthropic from '@anthropic-ai/sdk';
import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient, getUserFromRequest } from '@/lib/supabase/server';
import { SupabaseClient } from '@supabase/supabase-js';

const anthropic = new Anthropic();
const LIMIT_PER_DAY = 5;
const MAX_STR_LEN = 60;
const SUPPORTED_CURRENCIES = ['USD', 'JPY', 'EUR', 'CNY', 'GBP', 'AUD', 'CAD', 'CHF'];
const MAX_CURRENCIES = 6;

interface CurrencyTarget {
  level: number;
  action: string;
  confidence: string;
}

interface CurrencyAnalysis {
  currency: string;
  currentRate: number;
  recommendation: string;
  timing: string;
  analysis: string;
  targets: CurrencyTarget[];
}

interface FxTimingReport {
  analyses: CurrencyAnalysis[];
  overview: string;
}

function sanitize(s: unknown): string {
  if (typeof s !== 'string') return '';
  return s.replace(/[\n\r`#\[\]{}\\]/g, ' ').slice(0, MAX_STR_LEN).trim();
}

function todayUTC(): string {
  return new Date().toISOString().split('T')[0];
}

function todayUTCRange(): { start: string; end: string } {
  const today = new Date().toISOString().split('T')[0];
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().split('T')[0];
  return { start: `${today}T00:00:00.000Z`, end: `${tomorrow}T00:00:00.000Z` };
}

async function getBonusToday(supabase: SupabaseClient<any, any, any>, userId: string): Promise<number> {
  const today = todayUTC();
  const { data } = await supabase
    .from('ai_credits')
    .select('bonus')
    .eq('user_id', userId)
    .eq('date', today)
    .single();
  return data?.bonus ?? 0;
}

/** POST /api/ai/fx-timing — 통화별 최적 환전 타이밍 분석 */
export async function POST(request: NextRequest) {
  // 1. JWT 인증
  const user = await getUserFromRequest(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 2. 일일 사용량 + 보너스 크레딧 체크
  const supabase = createServiceClient();
  const { start, end } = todayUTCRange();

  const { count, error: countError } = await supabase
    .from('ai_reports')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .gte('created_at', start)
    .lt('created_at', end);

  if (countError) {
    console.error('[ai/fx-timing] count error:', countError);
    return NextResponse.json({ error: 'DB error' }, { status: 500 });
  }

  const usedToday = count ?? 0;
  const bonusToday = await getBonusToday(supabase, user.id);
  const effectiveLimit = LIMIT_PER_DAY + bonusToday;

  if (usedToday >= effectiveLimit) {
    return NextResponse.json(
      { error: 'Daily limit reached', usedToday, limitPerDay: LIMIT_PER_DAY, bonusToday },
      { status: 429 }
    );
  }

  // 3. 요청 바디 파싱 + 입력 검증
  let body: { currencies: string[]; rates: Record<string, number>; usdKrw: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { currencies, rates, usdKrw } = body;

  if (!Array.isArray(currencies) || currencies.length === 0) {
    return NextResponse.json({ error: 'No currencies provided' }, { status: 400 });
  }
  if (typeof rates !== 'object' || rates === null || Array.isArray(rates)) {
    return NextResponse.json({ error: 'Invalid rates object' }, { status: 400 });
  }
  if (typeof usdKrw !== 'number') {
    return NextResponse.json({ error: 'Invalid usdKrw' }, { status: 400 });
  }

  // 지원 통화 필터링 + 개수 제한
  const validCurrencies = currencies
    .map((c) => sanitize(c).toUpperCase())
    .filter((c) => SUPPORTED_CURRENCIES.includes(c))
    .slice(0, MAX_CURRENCIES);

  if (validCurrencies.length === 0) {
    return NextResponse.json({ error: 'No valid currencies' }, { status: 400 });
  }

  // 환율 데이터 라인 구성
  const rateLines = validCurrencies
    .map((currency) => {
      const rate = typeof rates[currency] === 'number' ? rates[currency] : null;
      if (rate === null) return `- ${currency}/KRW: 데이터 없음`;
      return `- ${currency}/KRW: ₩${rate.toLocaleString('ko-KR')} (1${currency} = ₩${Math.round(rate).toLocaleString('ko-KR')})`;
    })
    .join('\n');

  const prompt = `당신은 외환 전문가입니다. 아래 통화들의 현재 환율을 분석하고 최적 환전 타이밍을 추천해주세요.

## 현재 환율 데이터
${rateLines}
- USD/KRW 기준: ₩${Math.round(usdKrw).toLocaleString('ko-KR')}
- 기준일: ${todayUTC()}

## 분석 기준
- 최근 시장 트렌드 및 계절적 패턴 반영
- 중앙은행 정책 방향성 고려 (FED, ECB, BOJ 등)
- 한국 수출입 및 경상수지 영향
- recommendation: "buy_now"(지금 환전) | "wait"(기다림) | "sell_now"(원화 전환) 중 하나

## 출력 형식 (JSON만 출력, 코드블록 없이)
{"analyses":[{"currency":"string","currentRate":number,"recommendation":"string","timing":"string","analysis":"string","targets":[{"level":number,"action":"string","confidence":"string"}]}],"overview":"string"}

- analyses: 요청된 각 통화별 분석 (${validCurrencies.length}개)
- recommendation: "buy_now" | "wait" | "sell_now"
- timing: 환전 권장 시기 (예: "2-3주 후 환전 권장", "즉시 환전 적기")
- analysis: 환율 방향성 분석 (2-3문장)
- targets: 2-3개의 목표 환율 레벨
  - level: 목표 환율 (KRW)
  - action: "buy"(원화→외화) 또는 "sell"(외화→원화)
  - confidence: "high" | "medium" | "low"
- overview: 전체 외환 시장 동향 요약 (1-2문장)

한국어로 작성하세요.`;

  // 5. Claude Haiku 호출
  let reportData: FxTimingReport;
  try {
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1200,
      system: 'You are a foreign exchange expert. Always respond with valid JSON only. No explanations, no markdown code blocks, just the raw JSON object.',
      messages: [{ role: 'user', content: prompt }],
    });

    const rawText = message.content[0].type === 'text' ? message.content[0].text : '';
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    const jsonText = jsonMatch
      ? jsonMatch[0]
      : rawText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    reportData = JSON.parse(jsonText) as FxTimingReport;

    if (
      !Array.isArray(reportData.analyses) ||
      reportData.analyses.length === 0 ||
      typeof reportData.overview !== 'string'
    ) {
      throw new Error('Unexpected response structure');
    }
  } catch (err) {
    console.error('[ai/fx-timing] Claude API or parse error:', err);
    return NextResponse.json({ error: 'AI analysis failed' }, { status: 500 });
  }

  // 6. 사용 기록 저장
  const { error: insertError } = await supabase.from('ai_reports').insert({
    user_id: user.id,
    report_data: { ...reportData, _type: 'fx-timing' },
  });
  if (insertError) {
    console.error('[ai/fx-timing] insert error:', insertError);
  }

  return NextResponse.json({
    report: reportData,
    usedToday: usedToday + 1,
    limitPerDay: LIMIT_PER_DAY,
    bonusToday,
  });
}
