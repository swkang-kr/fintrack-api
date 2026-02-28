import Anthropic from '@anthropic-ai/sdk';
import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient, getUserFromRequest } from '@/lib/supabase/server';

const anthropic = new Anthropic();
const LIMIT_PER_DAY = 5;
const MAX_TICKERS = 8;

interface NewsTickerInput {
  ticker: string;
  name: string;
  yahooTicker: string;
}

interface AiNewsItem {
  ticker: string;
  name: string;
  sentiment: 'positive' | 'neutral' | 'negative';
  summary: string;
  headlines: string[];
}

interface AiNewsData {
  briefing: AiNewsItem[];
  overview: string;
}

function todayUTCRange(): { start: string; end: string } {
  const today = new Date().toISOString().split('T')[0];
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().split('T')[0];
  return {
    start: `${today}T00:00:00.000Z`,
    end: `${tomorrow}T00:00:00.000Z`,
  };
}

async function fetchYahooNews(name: string, yahooTicker: string): Promise<string[]> {
  // 종목명으로 먼저 검색 (한국 종목에 효과적), 실패 시 야후 티커로 재시도
  for (const query of [name, yahooTicker]) {
    try {
      const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&newsCount=3&enableFuzzyQuery=false&enableCb=false&quotesCount=0`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) continue;
      const data = await res.json();
      const headlines = (data.news ?? [])
        .slice(0, 3)
        .map((n: { title?: string }) => n.title)
        .filter(Boolean) as string[];
      if (headlines.length > 0) return headlines;
    } catch {
      continue;
    }
  }
  return [];
}

/** GET /api/ai/news — 오늘 사용량 조회 */
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

/** POST /api/ai/news — 보유 종목 뉴스 AI 브리핑 */
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

  let body: { tickers: NewsTickerInput[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { tickers } = body;
  if (!Array.isArray(tickers) || tickers.length === 0) {
    return NextResponse.json({ error: 'No tickers provided' }, { status: 400 });
  }

  const limited = tickers.slice(0, MAX_TICKERS);

  // 각 종목 뉴스를 병렬로 가져오기
  const newsResults = await Promise.all(
    limited.map(async (t) => {
      const headlines = await fetchYahooNews(t.name, t.yahooTicker);
      return { ...t, headlines };
    })
  );

  // 뉴스가 없는 종목도 포함 (AI가 종목명 기반으로 분석)
  const tickerLines = newsResults
    .map((t) =>
      t.headlines.length > 0
        ? `## ${t.name} (${t.ticker})\n${t.headlines.map((h) => `- ${h}`).join('\n')}`
        : `## ${t.name} (${t.ticker})\n- (최신 뉴스 없음)`
    )
    .join('\n\n');

  const prompt = `아래 주식 종목들의 뉴스를 분석하고 JSON으로 응답하세요.

## 종목별 뉴스 헤드라인
${tickerLines}

## 출력 규칙
- 모든 종목을 briefing 배열에 포함할 것
- 뉴스가 없는 종목: sentiment "neutral", summary "현재 최신 뉴스가 확인되지 않습니다", headlines []
- sentiment: positive/neutral/negative 중 하나
- 한국어로 작성

## 출력 형식
{"briefing":[{"ticker":"티커","name":"종목명","sentiment":"neutral","summary":"요약 1-2문장","headlines":["헤드라인"]}],"overview":"전체 분위기 1문장"}`;

  let newsData: AiNewsData;
  try {
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      system: 'You are a financial news analyst. Always respond with valid JSON only. No explanations, no markdown code blocks, just the raw JSON object.',
      messages: [{ role: 'user', content: prompt }],
    });

    const rawText = message.content[0].type === 'text' ? message.content[0].text : '';
    // JSON 객체를 정확히 추출 (텍스트 혼입 방지)
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    const jsonText = jsonMatch ? jsonMatch[0] : rawText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    newsData = JSON.parse(jsonText) as AiNewsData;

    if (!Array.isArray(newsData.briefing) || typeof newsData.overview !== 'string') {
      throw new Error('Unexpected response structure');
    }
    // briefing이 비어있으면 기본값으로 채움
    if (newsData.briefing.length === 0) {
      newsData.briefing = limited.map((t) => ({
        ticker: t.ticker,
        name: t.name,
        sentiment: 'neutral' as const,
        summary: '현재 최신 뉴스가 확인되지 않습니다.',
        headlines: [],
      }));
    }
  } catch (err) {
    console.error('[ai/news] AI or parse error:', err);
    return NextResponse.json({ error: 'AI analysis failed' }, { status: 500 });
  }

  const { error: insertError } = await supabase.from('ai_reports').insert({
    user_id: user.id,
    report_data: { ...newsData, _type: 'news' },
  });
  if (insertError) console.error('[ai/news] insert error:', insertError);

  return NextResponse.json({
    ...newsData,
    usedToday: usedToday + 1,
    limitPerDay: LIMIT_PER_DAY,
  });
}
