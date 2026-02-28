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

interface StockRecommendation {
  ticker: string;
  name: string;
  market: string;
  reason: string;
  risk: string;
  expectedReturn: string;
}

interface DiscoverReport {
  recommendations: StockRecommendation[];
  strategy: string;
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

/** POST /api/ai/discover — 포트폴리오 스타일 기반 종목 추천 */
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
    console.error('[ai/discover] count error:', countError);
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
      const pnl =
        typeof h.pnlPercent === 'number'
          ? `${h.pnlPercent >= 0 ? '+' : ''}${h.pnlPercent.toFixed(1)}%`
          : '-';
      const valueKrw = typeof h.valueKrw === 'number' ? h.valueKrw : 0;
      const weight =
        totalValueKrw > 0 ? ((valueKrw / totalValueKrw) * 100).toFixed(1) : '0.0';
      return `- ${name}(${ticker}, ${market}, ${currency}): ${qty}주 · 수익률 ${pnl} · 비중 ${weight}%`;
    })
    .join('\n');

  const totalPnlSign = totalPnlPercent >= 0 ? '+' : '';

  // 현재 보유 티커 목록 (중복 추천 방지)
  const existingTickers = holdings.map((h) => sanitize(h.ticker)).join(', ');

  const prompt = `당신은 AI 투자 어드바이저입니다. 아래 포트폴리오의 투자 스타일을 분석하고 새로운 종목을 추천해주세요.

## 포트폴리오 현황
- 총 평가금액: ₩${Math.round(totalValueKrw).toLocaleString('ko-KR')}
- 총 수익률: ${totalPnlSign}${totalPnlPercent.toFixed(1)}%
- USD/KRW 환율: ₩${Math.round(usdKrw).toLocaleString('ko-KR')}
- 종목 수: ${holdings.length}개

## 현재 보유 종목
${holdingLines}

## 중복 제외 티커
${existingTickers}

## 추천 요구사항
- 3-5개 종목 추천 (위 보유 종목과 겹치지 않게)
- 한국 주식(KOSPI/KOSDAQ)과 미국 주식(NASDAQ/NYSE) 혼합 추천
- 포트폴리오 스타일과 보완적인 종목 선정
- risk: "low" | "medium" | "high" 중 하나
- market: "KOSPI" | "KOSDAQ" | "NASDAQ" | "NYSE" 중 하나
- ticker: 한국 종목은 6자리 숫자(예: 005930), 미국 종목은 영문(예: AAPL)

## 출력 형식 (JSON만 출력, 코드블록 없이)
{"recommendations":[{"ticker":"string","name":"string","market":"string","reason":"string","risk":"string","expectedReturn":"string"}],"strategy":"string"}

- recommendations: 3-5개
- reason: 현재 포트폴리오와의 시너지 설명 (1-2문장)
- expectedReturn: 예상 연간 수익률 범위 (예: "연 8-12%")
- strategy: 전체 투자 전략 방향 (1-2문장)

한국어로 작성하세요.`;

  // 5. Claude Haiku 호출
  let reportData: DiscoverReport;
  try {
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1200,
      system: 'You are an investment advisor. Always respond with valid JSON only. No explanations, no markdown code blocks, just the raw JSON object.',
      messages: [{ role: 'user', content: prompt }],
    });

    const rawText = message.content[0].type === 'text' ? message.content[0].text : '';
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    const jsonText = jsonMatch
      ? jsonMatch[0]
      : rawText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    reportData = JSON.parse(jsonText) as DiscoverReport;

    if (
      !Array.isArray(reportData.recommendations) ||
      reportData.recommendations.length === 0 ||
      typeof reportData.strategy !== 'string'
    ) {
      throw new Error('Unexpected response structure');
    }

    // 추천 수 범위 보정 (3-5개)
    reportData.recommendations = reportData.recommendations.slice(0, 5);
  } catch (err) {
    console.error('[ai/discover] Claude API or parse error:', err);
    return NextResponse.json({ error: 'AI analysis failed' }, { status: 500 });
  }

  // 6. 사용 기록 저장
  const { error: insertError } = await supabase.from('ai_reports').insert({
    user_id: user.id,
    report_data: { ...reportData, _type: 'discover' },
  });
  if (insertError) {
    console.error('[ai/discover] insert error:', insertError);
  }

  return NextResponse.json({
    report: reportData,
    usedToday: usedToday + 1,
    limitPerDay: LIMIT_PER_DAY,
    bonusToday,
  });
}
