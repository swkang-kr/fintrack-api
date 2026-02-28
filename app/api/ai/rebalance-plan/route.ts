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

interface RebalanceStep {
  step: number;
  action: 'buy' | 'sell';
  ticker: string;
  name: string;
  quantity: number;
  estimatedAmount: number;
  reason: string;
}

interface RebalancePlanReport {
  steps: RebalanceStep[];
  summary: string;
  totalTransactions: number;
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

/** POST /api/ai/rebalance-plan — 리밸런싱 실행 계획 생성 */
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
    console.error('[ai/rebalance-plan] count error:', countError);
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
  let body: { holdings: HoldingInfo[]; totalValueKrw: number; totalPnlPercent: number; usdKrw: number };
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

  // 4. 프롬프트 구성
  const holdingLines = holdings
    .map((h) => {
      const name = sanitize(h.name);
      const ticker = sanitize(h.ticker);
      const market = sanitize(h.market);
      const currency = sanitize(h.currency);
      const qty = typeof h.quantity === 'number' ? h.quantity : 0;
      const sym = currency === 'USD' ? '$' : '₩';
      const currentPrice = typeof h.currentPrice === 'number' ? h.currentPrice : 0;
      const pnl =
        typeof h.pnlPercent === 'number'
          ? `${h.pnlPercent >= 0 ? '+' : ''}${h.pnlPercent.toFixed(1)}%`
          : '-';
      const valueKrw = typeof h.valueKrw === 'number' ? h.valueKrw : 0;
      const weight =
        totalValueKrw > 0 ? ((valueKrw / totalValueKrw) * 100).toFixed(1) : '0.0';
      return `- ${name}(${ticker}, ${market}, ${currency}): ${qty}주 · 현재가 ${sym}${currentPrice.toLocaleString('ko-KR')} · 수익률 ${pnl} · 비중 ${weight}% · 평가금액 ₩${Math.round(valueKrw).toLocaleString('ko-KR')}`;
    })
    .join('\n');

  const totalPnlSign = totalPnlPercent >= 0 ? '+' : '';

  const prompt = `당신은 포트폴리오 리밸런싱 전문가입니다. 아래 포트폴리오의 구체적인 리밸런싱 실행 계획을 수립해주세요.

## 포트폴리오 현황
- 총 평가금액: ₩${Math.round(totalValueKrw).toLocaleString('ko-KR')}
- 총 수익률: ${totalPnlSign}${totalPnlPercent.toFixed(1)}%
- USD/KRW 환율: ₩${Math.round(usdKrw).toLocaleString('ko-KR')}

## 보유 종목 (비중 포함)
${holdingLines}

## 리밸런싱 원칙
- 과도한 비중(30% 이상) 종목은 일부 매도 검토
- 손실 종목 중 회복 가능성이 낮은 종목은 손절 검토
- 분산 투자 개선을 위한 매수/매도 균형 조정
- 국내 주식(KOSPI/KOSDAQ): 반드시 정수 수량으로만 거래 (소수점 불가)
- 해외 주식: 소수점 거래 가능하나 실용적인 정수 권장

## 출력 형식 (JSON만 출력, 코드블록 없이)
{"steps":[{"step":number,"action":"sell","ticker":"string","name":"string","quantity":number,"estimatedAmount":number,"reason":"string"}],"summary":"string","totalTransactions":number}

- steps: 2-5개의 구체적 실행 단계 (우선순위 순)
- action: "buy" 또는 "sell"
- ticker: 보유 종목 티커 그대로 사용
- quantity: 거래 수량 (국내주식은 반드시 양의 정수)
- estimatedAmount: 예상 거래금액 (원화 기준)
- reason: 이 거래가 필요한 이유 (1문장)
- summary: 전체 리밸런싱 전략 설명 (2-3문장)
- totalTransactions: steps 배열 길이와 동일

한국어로 작성하세요.`;

  // 5. Claude Haiku 호출
  let reportData: RebalancePlanReport;
  try {
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1200,
      system: 'You are a portfolio rebalancing expert. Always respond with valid JSON only. No explanations, no markdown code blocks, just the raw JSON object.',
      messages: [{ role: 'user', content: prompt }],
    });

    const rawText = message.content[0].type === 'text' ? message.content[0].text : '';
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    const jsonText = jsonMatch
      ? jsonMatch[0]
      : rawText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    reportData = JSON.parse(jsonText) as RebalancePlanReport;

    if (
      !Array.isArray(reportData.steps) ||
      reportData.steps.length === 0 ||
      typeof reportData.summary !== 'string' ||
      typeof reportData.totalTransactions !== 'number'
    ) {
      throw new Error('Unexpected response structure');
    }

    // 단계 수 보정 (2-5개)
    reportData.steps = reportData.steps.slice(0, 5);
    reportData.totalTransactions = reportData.steps.length;

    // 국내 주식 수량 정수화
    reportData.steps = reportData.steps.map((step, idx) => {
      const holding = holdings.find((h) => sanitize(h.ticker) === step.ticker);
      const isKorean = holding
        ? holding.market === 'KOSPI' || holding.market === 'KOSDAQ'
        : /^\d{6}$/.test(step.ticker ?? '');
      return {
        ...step,
        step: idx + 1,
        quantity: isKorean ? Math.max(1, Math.round(step.quantity)) : step.quantity,
      };
    });
  } catch (err) {
    console.error('[ai/rebalance-plan] Claude API or parse error:', err);
    return NextResponse.json({ error: 'AI analysis failed' }, { status: 500 });
  }

  // 6. 사용 기록 저장
  const { error: insertError } = await supabase.from('ai_reports').insert({
    user_id: user.id,
    report_data: { ...reportData, _type: 'rebalance-plan' },
  });
  if (insertError) {
    console.error('[ai/rebalance-plan] insert error:', insertError);
  }

  return NextResponse.json({
    report: reportData,
    usedToday: usedToday + 1,
    limitPerDay: LIMIT_PER_DAY,
    bonusToday,
  });
}
