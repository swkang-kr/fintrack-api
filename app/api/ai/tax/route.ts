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

interface TaxStrategy {
  title: string;
  description: string;
  action: string;
  saving: number;
}

interface TaxReport {
  currentTax: number;
  optimizedTax: number;
  saving: number;
  strategies: TaxStrategy[];
  disclaimer: string;
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

/** POST /api/ai/tax — 세금 최적화 전략 분석 */
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
    console.error('[ai/tax] count error:', countError);
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
      return `- ${name}(${ticker}, ${market}, ${currency}): ${qty}주 · 평균매수가 ${sym}${avgP.toLocaleString('ko-KR')} · 현재가 ${price} · 수익률 ${pnl} · 평가금액 ₩${Math.round(valueKrw).toLocaleString('ko-KR')}`;
    })
    .join('\n');

  const totalPnlSign = totalPnlPercent >= 0 ? '+' : '';

  const prompt = `You are a Korean tax advisor. Analyze this portfolio for capital gains tax optimization.

## 포트폴리오 현황
- 총 평가금액: ₩${Math.round(totalValueKrw).toLocaleString('ko-KR')}
- 총 수익률: ${totalPnlSign}${totalPnlPercent.toFixed(1)}%
- 현재 USD/KRW 환율: ₩${Math.round(usdKrw).toLocaleString('ko-KR')}

## 보유 종목
${holdingLines}

## 한국 세금 규정
- 해외주식 양도소득세: 연간 수익 250만원 초과분의 22% (지방소득세 포함)
- 국내주식(KOSPI/KOSDAQ): 대주주 아닌 경우 비과세
- 배당소득세: 15.4% (금융종합과세 기준액 초과 시 종합과세)
- 손익통산 가능: 같은 해 발생한 해외주식 손실과 이익 합산

## 출력 형식 (JSON만 출력, 코드블록 없이)
{"currentTax":number,"optimizedTax":number,"saving":number,"strategies":[{"title":"string","description":"string","action":"string","saving":number}],"disclaimer":"string"}

- currentTax: 현재 예상 세금 (원)
- optimizedTax: 최적화 후 예상 세금 (원)
- saving: 절세 가능 금액 (원)
- strategies: 2-4개의 구체적 절세 전략
- disclaimer: 세무사 상담 권고 문구

한국어로 작성하고 구체적인 금액을 포함한 실용적인 전략을 제시하세요.`;

  // 5. Claude Haiku 호출
  let reportData: TaxReport;
  try {
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1200,
      system: 'You are a Korean tax advisor. Always respond with valid JSON only. No explanations, no markdown code blocks, just the raw JSON object.',
      messages: [{ role: 'user', content: prompt }],
    });

    const rawText = message.content[0].type === 'text' ? message.content[0].text : '';
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    const jsonText = jsonMatch
      ? jsonMatch[0]
      : rawText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    reportData = JSON.parse(jsonText) as TaxReport;

    if (
      typeof reportData.currentTax !== 'number' ||
      typeof reportData.optimizedTax !== 'number' ||
      typeof reportData.saving !== 'number' ||
      !Array.isArray(reportData.strategies) ||
      typeof reportData.disclaimer !== 'string'
    ) {
      throw new Error('Unexpected response structure');
    }
  } catch (err) {
    console.error('[ai/tax] Claude API or parse error:', err);
    return NextResponse.json({ error: 'AI analysis failed' }, { status: 500 });
  }

  // 6. 사용 기록 저장
  const { error: insertError } = await supabase.from('ai_reports').insert({
    user_id: user.id,
    report_data: { ...reportData, _type: 'tax' },
  });
  if (insertError) {
    console.error('[ai/tax] insert error:', insertError);
  }

  return NextResponse.json({
    report: reportData,
    usedToday: usedToday + 1,
    limitPerDay: LIMIT_PER_DAY,
    bonusToday,
  });
}
