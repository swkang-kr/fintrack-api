import Anthropic from '@anthropic-ai/sdk';
import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient, getUserFromRequest } from '@/lib/supabase/server';
import { SupabaseClient } from '@supabase/supabase-js';

const anthropic = new Anthropic();
const LIMIT_PER_DAY = 5;
const MAX_HOLDINGS = 30;
const MAX_STR_LEN = 60;
const MAX_MESSAGES = 10;
const MAX_MSG_CONTENT_LEN = 500;

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

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface ChatBody {
  messages: ChatMessage[];
  holdings: HoldingInfo[];
  totalValueKrw: number;
  usdKrw: number;
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

/** POST /api/ai/chat — 포트폴리오 컨텍스트 기반 AI 챗 */
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
    console.error('[ai/chat] count error:', countError);
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
  let body: ChatBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { messages, holdings, totalValueKrw, usdKrw } = body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return NextResponse.json({ error: 'No messages provided' }, { status: 400 });
  }
  if (!Array.isArray(holdings) || holdings.length === 0) {
    return NextResponse.json({ error: 'No holdings provided' }, { status: 400 });
  }
  if (holdings.length > MAX_HOLDINGS) {
    return NextResponse.json(
      { error: `Holdings must be ${MAX_HOLDINGS} or fewer` },
      { status: 400 }
    );
  }
  if (typeof totalValueKrw !== 'number' || typeof usdKrw !== 'number') {
    return NextResponse.json({ error: 'Invalid numeric fields' }, { status: 400 });
  }

  // 메시지 수 + 내용 길이 제한
  const limitedMessages = messages.slice(-MAX_MESSAGES);
  const validMessages = limitedMessages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({
      role: m.role,
      content: m.content.replace(/[\n\r`#\[\]{}\\]/g, ' ').slice(0, MAX_MSG_CONTENT_LEN).trim(),
    }));

  if (validMessages.length === 0) {
    return NextResponse.json({ error: 'No valid messages' }, { status: 400 });
  }

  // 4. 포트폴리오 컨텍스트 구성
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

  const systemPrompt = `You are an AI investment advisor speaking Korean. Portfolio context:
총 평가금액: ₩${Math.round(totalValueKrw).toLocaleString('ko-KR')}
현재 USD/KRW 환율: ₩${Math.round(usdKrw).toLocaleString('ko-KR')}

보유 종목:
${holdingLines}

Answer the user's question about their portfolio in Korean. Be specific and helpful. Provide concrete numbers and actionable advice when possible.`;

  // 5. Claude Haiku 호출 (multi-turn)
  let replyMessage: string;
  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      system: systemPrompt,
      messages: validMessages as Anthropic.MessageParam[],
    });

    replyMessage =
      response.content[0].type === 'text' ? response.content[0].text.trim() : '';

    if (!replyMessage) {
      throw new Error('Empty response from Claude');
    }
  } catch (err) {
    console.error('[ai/chat] Claude API error:', err);
    return NextResponse.json({ error: 'AI chat failed' }, { status: 500 });
  }

  // 6. 사용 기록 저장
  const { error: insertError } = await supabase.from('ai_reports').insert({
    user_id: user.id,
    report_data: { message: replyMessage, messageCount: validMessages.length, _type: 'chat' },
  });
  if (insertError) {
    console.error('[ai/chat] insert error:', insertError);
  }

  return NextResponse.json({
    message: replyMessage,
    usedToday: usedToday + 1,
    limitPerDay: LIMIT_PER_DAY,
    bonusToday,
  });
}
