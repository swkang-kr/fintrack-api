import Anthropic from '@anthropic-ai/sdk';
import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient, getUserFromRequest } from '@/lib/supabase/server';

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

interface ImproveBody {
  holdings: HoldingInfo[];
  totalValueKrw: number;
  totalPnlPercent: number;
  usdKrw: number;
}

interface ImprovementItem {
  priority: 'high' | 'medium' | 'low';
  title: string;
  description: string;
}

interface ImproveData {
  summary: string;
  improvements: ImprovementItem[];
  rebalancing: string;
}

function sanitize(s: unknown): string {
  if (typeof s !== 'string') return '';
  return s
    .replace(/[\n\r`#\[\]{}\\]/g, ' ')
    .slice(0, MAX_STR_LEN)
    .trim();
}

function todayUTCRange(): { start: string; end: string } {
  const today = new Date().toISOString().split('T')[0];
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().split('T')[0];
  return {
    start: `${today}T00:00:00.000Z`,
    end: `${tomorrow}T00:00:00.000Z`,
  };
}

/** GET /api/ai/improve — 오늘 사용량 조회 (analyze와 공유) */
export async function GET(request: NextRequest) {
  const user = await getUserFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createServiceClient();
  const { start, end } = todayUTCRange();

  const { count, error } = await supabase
    .from('ai_reports')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .gte('created_at', start)
    .lt('created_at', end);

  if (error) return NextResponse.json({ error: 'DB error' }, { status: 500 });
  return NextResponse.json({ usedToday: count ?? 0, limitPerDay: LIMIT_PER_DAY });
}

/** POST /api/ai/improve — 포트폴리오 개선 제안 */
export async function POST(request: NextRequest) {
  const user = await getUserFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createServiceClient();
  const { start, end } = todayUTCRange();

  const { count, error: countError } = await supabase
    .from('ai_reports')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .gte('created_at', start)
    .lt('created_at', end);

  if (countError) return NextResponse.json({ error: 'DB error' }, { status: 500 });

  const usedToday = count ?? 0;
  if (usedToday >= LIMIT_PER_DAY) {
    return NextResponse.json(
      { error: 'Daily limit reached', usedToday, limitPerDay: LIMIT_PER_DAY },
      { status: 429 }
    );
  }

  let body: ImproveBody;
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
    return NextResponse.json({ error: `Holdings must be ${MAX_HOLDINGS} or fewer` }, { status: 400 });
  }

  // 섹터/비중 계산
  const totalValue = totalValueKrw || 1;
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
      const weight = ((valueKrw / totalValue) * 100).toFixed(1);
      return `- ${name}(${ticker}, ${market}): ${qty}주 · 매입가 ${sym}${avgP.toLocaleString('ko-KR')} · 현재가 ${price} · 수익률 ${pnl} · 비중 ${weight}%`;
    })
    .join('\n');

  const totalPnlSign = totalPnlPercent >= 0 ? '+' : '';

  const prompt = `당신은 전문 포트폴리오 매니저입니다. 아래 포트폴리오의 구체적인 개선 방향을 JSON 형식으로만 답변해주세요.

## 포트폴리오 현황
- 총 평가금액: ₩${Math.round(totalValueKrw).toLocaleString('ko-KR')}
- 총 수익률: ${totalPnlSign}${totalPnlPercent.toFixed(1)}%
- USD/KRW 환율: ₩${Math.round(usdKrw).toLocaleString('ko-KR')}

## 보유 종목 (비중 포함)
${holdingLines}

## 중요 제약사항
- 국내 주식(KOSPI, KOSDAQ)은 소수점 거래 불가 — 매수/매도 추천 시 반드시 1주 단위 정수로만 제안
- 해외 주식(NASDAQ, NYSE 등)은 소수점 거래 가능

## 출력 형식 (JSON만 출력, 코드블록 없이)
{"summary":"포트폴리오 현황 평가 (1-2문장)","improvements":[{"priority":"high","title":"개선 제목 (10자 이내)","description":"구체적인 설명과 실행 방법 (2-3문장)"}],"rebalancing":"즉시 실행 가능한 리밸런싱 방법 (1-2문장)"}

improvements는 3-5개로 제한. priority는 high/medium/low 중 하나. 종목명·비중·수치를 언급한 구체적인 개선안을 제시하세요. 한국어로 작성하세요.`;

  let improveData: ImproveData;
  try {
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1200,
      messages: [{ role: 'user', content: prompt }],
    });

    const rawText = message.content[0].type === 'text' ? message.content[0].text : '';
    const jsonText = rawText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    improveData = JSON.parse(jsonText) as ImproveData;

    if (
      typeof improveData.summary !== 'string' ||
      !Array.isArray(improveData.improvements) ||
      typeof improveData.rebalancing !== 'string'
    ) {
      throw new Error('Unexpected response structure');
    }
  } catch (err) {
    console.error('[ai/improve] AI or parse error:', err);
    return NextResponse.json({ error: 'AI analysis failed' }, { status: 500 });
  }

  const { error: insertError } = await supabase.from('ai_reports').insert({
    user_id: user.id,
    report_data: { ...improveData, _type: 'improve' },
  });
  if (insertError) console.error('[ai/improve] insert error:', insertError);

  return NextResponse.json({
    report: improveData,
    usedToday: usedToday + 1,
    limitPerDay: LIMIT_PER_DAY,
  });
}
