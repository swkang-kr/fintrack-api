import Anthropic from '@anthropic-ai/sdk';
import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase/server';

const anthropic = new Anthropic();

/** 이미지에서 파싱된 종목 */
interface ParsedHolding {
  name: string;
  ticker: string;
  market: string;
  currency: string;
  quantity: number;
  avg_price: number;
}

interface ScanResult {
  holdings: ParsedHolding[];
  message: string;
}

const PROMPT = `당신은 증권사 앱 스크린샷에서 보유 종목 정보를 추출하는 전문가입니다.

이미지를 분석하여 보유 종목 목록을 JSON으로 추출하세요.

## 추출 규칙
- name: 종목명 (예: "삼성전자", "Apple Inc.")
- ticker: 종목 코드 (예: "005930", "AAPL")
  - 국내 주식: 6자리 숫자 코드 (예: 005930, 000660)
  - 해외 주식: 영문 티커 (예: AAPL, TSLA, MSFT)
- market: 시장 구분
  - 국내 유가증권시장 → "KOSPI"
  - 국내 코스닥 → "KOSDAQ"
  - 미국 나스닥 → "NASDAQ"
  - 미국 뉴욕증권거래소 → "NYSE"
  - 기타 해외 → 해당 거래소명
- currency: "KRW" (국내) 또는 "USD" (미국/해외)
- quantity: 보유 수량 (숫자, 소수점 포함 가능)
- avg_price: 평균 매수가 (해당 통화 기준 숫자, 콤마 없이)
  - KRW: 원화 단가 (예: 72500)
  - USD: 달러 단가 (예: 185.50)

## 주의사항
- 티커를 확인할 수 없으면 종목명을 기반으로 추정하세요
- 수량이나 단가가 보이지 않으면 0으로 설정하세요
- 평가금액(현재 가치)이 아닌 평균매수가(매입 단가)를 추출하세요
- KIS, NH투자증권, 키움, 미래에셋 등 다양한 증권사 화면 지원

## 출력 형식 (JSON만 출력, 코드블록 없이)
{"holdings":[{"name":"삼성전자","ticker":"005930","market":"KOSPI","currency":"KRW","quantity":10,"avg_price":72500}],"message":"N개 종목이 감지되었습니다."}

종목을 전혀 찾을 수 없으면: {"holdings":[],"message":"종목 정보를 찾을 수 없습니다."}`;

/** POST /api/ai/scan-portfolio — 스크린샷에서 포트폴리오 추출 */
export async function POST(request: NextRequest) {
  const user = await getUserFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { imageBase64: string; mimeType?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { imageBase64, mimeType = 'image/jpeg' } = body;

  if (!imageBase64 || typeof imageBase64 !== 'string') {
    return NextResponse.json({ error: 'imageBase64 required' }, { status: 400 });
  }

  // 이미지 크기 제한 (base64 ~ 5MB = ~3.75MB binary)
  if (imageBase64.length > 5_000_000) {
    return NextResponse.json({ error: '이미지가 너무 큽니다. 더 작은 이미지를 사용해주세요.' }, { status: 400 });
  }

  let result: ScanResult;
  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',   // Vision은 Sonnet 사용 (더 정확한 OCR)
      max_tokens: 1500,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
                data: imageBase64,
              },
            },
            {
              type: 'text',
              text: PROMPT,
            },
          ],
        },
      ],
    });

    const rawText = message.content[0].type === 'text' ? message.content[0].text : '';
    const jsonText = rawText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    result = JSON.parse(jsonText) as ScanResult;

    if (!Array.isArray(result.holdings)) {
      throw new Error('Unexpected response structure');
    }

    // 데이터 정제
    result.holdings = result.holdings.map((h) => ({
      name: String(h.name ?? '').trim().slice(0, 80),
      ticker: String(h.ticker ?? '').trim().replace(/[^A-Za-z0-9]/g, ''),
      market: String(h.market ?? 'KOSPI').trim().toUpperCase(),
      currency: String(h.currency ?? 'KRW').trim().toUpperCase() === 'USD' ? 'USD' : 'KRW',
      quantity: typeof h.quantity === 'number' && h.quantity > 0 ? h.quantity : 0,
      avg_price: typeof h.avg_price === 'number' && h.avg_price > 0 ? h.avg_price : 0,
    })).filter((h) => h.name && h.ticker);

  } catch (err) {
    console.error('[ai/scan-portfolio] error:', err);
    return NextResponse.json({ error: 'AI analysis failed' }, { status: 500 });
  }

  return NextResponse.json(result);
}
