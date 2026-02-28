import Anthropic from '@anthropic-ai/sdk';
import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient, getUserFromRequest } from '@/lib/supabase/server';
import { SupabaseClient } from '@supabase/supabase-js';

const anthropic = new Anthropic();
const LIMIT_PER_DAY = 5;
const MAX_HOLDINGS = 30;
const MAX_STR_LEN = 60;

interface HoldingInfo {
  name: string;
  ticker: string;
  market: string;
  quantity: number;
  avgPrice: number;
  currentPrice: number | null;
  currency: string;
  pnlPercent: number | null;
  valueKrw: number;
}

interface AnalyzeBody {
  holdings: HoldingInfo[];
  totalValueKrw: number;
  totalPnlPercent: number;
  usdKrw: number;
}

interface ReportData {
  summary: string;
  insights: string[];
  risks: string[];
  recommendation: string;
}

/** 프롬프트 인젝션 방지: 제어 문자·마크다운 헤더를 제거하고 길이를 제한 */
function sanitize(s: unknown): string {
  if (typeof s !== 'string') return '';
  return s
    .replace(/[\n\r`#\[\]{}\\]/g, ' ')
    .slice(0, MAX_STR_LEN)
    .trim();
}

/** 오늘(UTC) 날짜 문자열 YYYY-MM-DD */
function todayUTC(): string {
  return new Date().toISOString().split('T')[0];
}

/** 오늘(UTC)의 시작과 종료 ISO 문자열 반환 */
function todayUTCRange(): { start: string; end: string } {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().split('T')[0];
  return {
    start: `${today}T00:00:00.000Z`,
    end: `${tomorrow}T00:00:00.000Z`, // lt(end) = 오늘 23:59:59.999... 전체 포함
  };
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

/** GET /api/ai/analyze — 오늘 사용량 조회 */
export async function GET(request: NextRequest) {
  const user = await getUserFromRequest(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createServiceClient();
  const { start, end } = todayUTCRange();

  const { count, error } = await supabase
    .from('ai_reports')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .gte('created_at', start)
    .lt('created_at', end);

  if (error) {
    return NextResponse.json({ error: 'DB error' }, { status: 500 });
  }

  const usedToday = count ?? 0;
  const bonusToday = await getBonusToday(supabase, user.id);

  return NextResponse.json({
    usedToday,
    limitPerDay: LIMIT_PER_DAY,
    bonusToday,
    effectiveLimit: LIMIT_PER_DAY + bonusToday,
  });
}

/** POST /api/ai/analyze — 포트폴리오 분석 */
export async function POST(request: NextRequest) {
  // 1. JWT 인증
  const user = await getUserFromRequest(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 2. 일일 사용량 체크 (올바른 UTC 날짜 범위)
  const supabase = createServiceClient();
  const { start, end } = todayUTCRange();

  const { count, error: countError } = await supabase
    .from('ai_reports')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .gte('created_at', start)
    .lt('created_at', end);

  if (countError) {
    console.error('[ai/analyze] count error:', countError);
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
  let body: AnalyzeBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { holdings, totalValueKrw, totalPnlPercent, usdKrw } = body;

  if (!Array.isArray(holdings) || holdings.length === 0) {
    return NextResponse.json({ error: 'No holdings to analyze' }, { status: 400 });
  }
  if (holdings.length > MAX_HOLDINGS) {
    return NextResponse.json(
      { error: `Holdings must be ${MAX_HOLDINGS} or fewer` },
      { status: 400 }
    );
  }
  if (
    typeof totalValueKrw !== 'number' ||
    typeof totalPnlPercent !== 'number' ||
    typeof usdKrw !== 'number'
  ) {
    return NextResponse.json({ error: 'Invalid numeric fields' }, { status: 400 });
  }

  // 4. 프롬프트 구성 (문자열 sanitize 후 삽입)
  const holdingLines = holdings
    .map((h) => {
      const name = sanitize(h.name);
      const ticker = sanitize(h.ticker);
      const market = sanitize(h.market);
      const currency = sanitize(h.currency);

      const qty = typeof h.quantity === 'number' ? h.quantity : 0;
      const avgP = typeof h.avgPrice === 'number' ? h.avgPrice : 0;
      const sym = currency === 'USD' ? '$' : '₩';

      const price =
        typeof h.currentPrice === 'number'
          ? `${sym}${h.currentPrice.toLocaleString('ko-KR')}`
          : '시세 없음';
      const pnl =
        typeof h.pnlPercent === 'number'
          ? `${h.pnlPercent >= 0 ? '+' : ''}${h.pnlPercent.toFixed(1)}%`
          : '-';
      const valueKrw = typeof h.valueKrw === 'number' ? h.valueKrw : 0;

      return `- ${name}(${ticker}, ${market}): ${qty}주 · 평균매수가 ${sym}${avgP.toLocaleString('ko-KR')} · 현재가 ${price} · 수익률 ${pnl} · 평가금액 ₩${Math.round(valueKrw).toLocaleString('ko-KR')}`;
    })
    .join('\n');

  const totalPnlSign = totalPnlPercent >= 0 ? '+' : '';

  const prompt = `당신은 전문 투자 분석가입니다. 아래 포트폴리오를 분석하고 JSON 형식으로만 답변해주세요.

## 포트폴리오 현황
- 총 평가금액: ₩${Math.round(totalValueKrw).toLocaleString('ko-KR')}
- 총 수익률: ${totalPnlSign}${totalPnlPercent.toFixed(1)}%
- 현재 USD/KRW 환율: ₩${Math.round(usdKrw).toLocaleString('ko-KR')}

## 보유 종목
${holdingLines}

## 중요 제약사항
- 국내 주식(KOSPI, KOSDAQ)은 소수점 거래 불가 — 매수/매도 추천 시 반드시 1주 단위 정수로만 제안
- 해외 주식(NASDAQ, NYSE 등)은 소수점 거래 가능

## 출력 형식 (JSON만 출력, 코드블록 없이)
{"summary":"포트폴리오 전체 요약 (2-3문장)","insights":["인사이트1","인사이트2","인사이트3"],"risks":["리스크1","리스크2"],"recommendation":"종합 투자 조언 (1-2문장)"}

한국어로 작성하고 구체적이고 실용적인 분석을 제공하세요.`;

  // 5. Claude Haiku 호출
  let reportData: ReportData;
  try {
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }],
    });

    const rawText =
      message.content[0].type === 'text' ? message.content[0].text : '';
    const jsonText = rawText
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .trim();
    reportData = JSON.parse(jsonText) as ReportData;

    // 응답 구조 검증
    if (
      typeof reportData.summary !== 'string' ||
      !Array.isArray(reportData.insights) ||
      !Array.isArray(reportData.risks) ||
      typeof reportData.recommendation !== 'string'
    ) {
      throw new Error('Unexpected response structure');
    }
  } catch (err) {
    console.error('[ai/analyze] Claude API or parse error:', err);
    return NextResponse.json({ error: 'AI analysis failed' }, { status: 500 });
  }

  // 6. 사용 기록 저장 (실패해도 응답은 반환)
  const { error: insertError } = await supabase.from('ai_reports').insert({
    user_id: user.id,
    report_data: { ...reportData, _type: 'analyze' },
  });
  if (insertError) {
    console.error('[ai/analyze] insert error:', insertError);
  }

  return NextResponse.json({
    report: reportData,
    usedToday: usedToday + 1,
    limitPerDay: LIMIT_PER_DAY,
    bonusToday,
  });
}
