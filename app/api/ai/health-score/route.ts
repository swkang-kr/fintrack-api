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

interface HealthFactor {
  name: string;
  score: number;
  comment: string;
}

interface HealthScoreReport {
  score: number;
  grade: string;
  factors: HealthFactor[];
  summary: string;
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

function deriveGrade(score: number): string {
  if (score >= 90) return 'A';
  if (score >= 75) return 'B';
  if (score >= 60) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

/** POST /api/ai/health-score — 포트폴리오 건강도 점수 분석 */
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
    console.error('[ai/health-score] count error:', countError);
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
      const price =
        typeof h.currentPrice === 'number'
          ? `${sym}${h.currentPrice.toLocaleString('ko-KR')}`
          : '시세 없음';
      const pnl =
        typeof h.pnlPercent === 'number'
          ? `${h.pnlPercent >= 0 ? '+' : ''}${h.pnlPercent.toFixed(1)}%`
          : '-';
      const valueKrw = typeof h.valueKrw === 'number' ? h.valueKrw : 0;
      const weight =
        totalValueKrw > 0 ? ((valueKrw / totalValueKrw) * 100).toFixed(1) : '0.0';
      return `- ${name}(${ticker}, ${market}): ${qty}주 · 현재가 ${price} · 수익률 ${pnl} · 비중 ${weight}%`;
    })
    .join('\n');

  const totalPnlSign = totalPnlPercent >= 0 ? '+' : '';

  const prompt = `당신은 포트폴리오 건강도 분석 전문가입니다. 아래 포트폴리오를 0-100점으로 평가해주세요.

## 포트폴리오 현황
- 총 평가금액: ₩${Math.round(totalValueKrw).toLocaleString('ko-KR')}
- 총 수익률: ${totalPnlSign}${totalPnlPercent.toFixed(1)}%
- 현재 USD/KRW 환율: ₩${Math.round(usdKrw).toLocaleString('ko-KR')}
- 종목 수: ${holdings.length}개

## 보유 종목 (비중 포함)
${holdingLines}

## 평가 기준
- 분산도(diversification): 종목 수, 섹터/시장/통화 다양성, 집중도 리스크
- 수익률(performance): 현재 수익률, 손실 종목 비율
- 리스크(risk): 변동성, 고위험 종목 비중, 환율 익스포저
- 유동성(liquidity): 대형주/우량주 비중, 거래량 추정

## 등급 기준
- A: 90점 이상, B: 75-89점, C: 60-74점, D: 40-59점, F: 40점 미만

## 출력 형식 (JSON만 출력, 코드블록 없이)
{"score":number,"grade":"string","factors":[{"name":"분산도","score":number,"comment":"string"},{"name":"수익률","score":number,"comment":"string"},{"name":"리스크","score":number,"comment":"string"},{"name":"유동성","score":number,"comment":"string"}],"summary":"string"}

- score: 전체 건강도 점수 (0-100)
- grade: A/B/C/D/F
- factors: 반드시 4개 (분산도, 수익률, 리스크, 유동성)
- summary: 포트폴리오 전반 평가 (2-3문장)

한국어로 작성하고 구체적인 개선 포인트를 포함하세요.`;

  // 5. Claude Haiku 호출
  let reportData: HealthScoreReport;
  try {
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      system: 'You are a portfolio health analyst. Always respond with valid JSON only. No explanations, no markdown code blocks, just the raw JSON object.',
      messages: [{ role: 'user', content: prompt }],
    });

    const rawText = message.content[0].type === 'text' ? message.content[0].text : '';
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    const jsonText = jsonMatch
      ? jsonMatch[0]
      : rawText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    reportData = JSON.parse(jsonText) as HealthScoreReport;

    if (
      typeof reportData.score !== 'number' ||
      typeof reportData.grade !== 'string' ||
      !Array.isArray(reportData.factors) ||
      typeof reportData.summary !== 'string'
    ) {
      throw new Error('Unexpected response structure');
    }

    // 점수 범위 보정 + grade 재계산 (AI 오류 방지)
    reportData.score = Math.max(0, Math.min(100, Math.round(reportData.score)));
    reportData.grade = deriveGrade(reportData.score);
  } catch (err) {
    console.error('[ai/health-score] Claude API or parse error:', err);
    return NextResponse.json({ error: 'AI analysis failed' }, { status: 500 });
  }

  // 6. 사용 기록 저장
  const { error: insertError } = await supabase.from('ai_reports').insert({
    user_id: user.id,
    report_data: { ...reportData, _type: 'health-score' },
  });
  if (insertError) {
    console.error('[ai/health-score] insert error:', insertError);
  }

  return NextResponse.json({
    report: reportData,
    usedToday: usedToday + 1,
    limitPerDay: LIMIT_PER_DAY,
    bonusToday,
  });
}
