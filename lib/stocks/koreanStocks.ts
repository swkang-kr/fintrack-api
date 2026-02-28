/**
 * 한국 인기 종목 정적 데이터베이스 (시가총액 상위 + 주요 종목)
 * Yahoo Finance가 한글 검색을 지원하지 않아 로컬 DB로 대체
 */

export interface KoreanStock {
  ticker: string;   // 6자리 코드 (예: '005930')
  name: string;     // 한글 종목명
  market: 'KOSPI' | 'KOSDAQ';
}

export const KOREAN_STOCKS: KoreanStock[] = [
  // ── KOSPI 시가총액 상위 ───────────────────────────────
  { ticker: '005930', name: '삼성전자', market: 'KOSPI' },
  { ticker: '000660', name: 'SK하이닉스', market: 'KOSPI' },
  { ticker: '207940', name: '삼성바이오로직스', market: 'KOSPI' },
  { ticker: '005380', name: '현대차', market: 'KOSPI' },
  { ticker: '000270', name: '기아', market: 'KOSPI' },
  { ticker: '068270', name: '셀트리온', market: 'KOSPI' },
  { ticker: '035420', name: 'NAVER', market: 'KOSPI' },
  { ticker: '105560', name: 'KB금융', market: 'KOSPI' },
  { ticker: '055550', name: '신한지주', market: 'KOSPI' },
  { ticker: '005490', name: 'POSCO홀딩스', market: 'KOSPI' },
  { ticker: '086790', name: '하나금융지주', market: 'KOSPI' },
  { ticker: '012330', name: '현대모비스', market: 'KOSPI' },
  { ticker: '028260', name: '삼성물산', market: 'KOSPI' },
  { ticker: '066570', name: 'LG전자', market: 'KOSPI' },
  { ticker: '017670', name: 'SK텔레콤', market: 'KOSPI' },
  { ticker: '003550', name: 'LG', market: 'KOSPI' },
  { ticker: '316140', name: '우리금융지주', market: 'KOSPI' },
  { ticker: '096770', name: 'SK이노베이션', market: 'KOSPI' },
  { ticker: '030200', name: 'KT', market: 'KOSPI' },
  { ticker: '033780', name: 'KT&G', market: 'KOSPI' },
  { ticker: '003670', name: '포스코퓨처엠', market: 'KOSPI' },
  { ticker: '009540', name: 'HD한국조선해양', market: 'KOSPI' },
  { ticker: '034730', name: 'SK', market: 'KOSPI' },
  { ticker: '015760', name: '한국전력', market: 'KOSPI' },
  { ticker: '032830', name: '삼성생명', market: 'KOSPI' },
  { ticker: '010950', name: 'S-Oil', market: 'KOSPI' },
  { ticker: '009150', name: '삼성전기', market: 'KOSPI' },
  { ticker: '010140', name: '삼성중공업', market: 'KOSPI' },
  { ticker: '018260', name: '삼성에스디에스', market: 'KOSPI' },
  { ticker: '003490', name: '대한항공', market: 'KOSPI' },
  { ticker: '011200', name: 'HMM', market: 'KOSPI' },
  { ticker: '047050', name: '포스코인터내셔널', market: 'KOSPI' },
  { ticker: '000810', name: '삼성화재', market: 'KOSPI' },
  { ticker: '000100', name: '유한양행', market: 'KOSPI' },
  { ticker: '011170', name: '롯데케미칼', market: 'KOSPI' },
  { ticker: '097950', name: 'CJ제일제당', market: 'KOSPI' },
  { ticker: '051910', name: 'LG화학', market: 'KOSPI' },
  { ticker: '006400', name: '삼성SDI', market: 'KOSPI' },
  { ticker: '373220', name: 'LG에너지솔루션', market: 'KOSPI' },
  { ticker: '247540', name: '에코프로비엠', market: 'KOSPI' },
  { ticker: '086520', name: '에코프로', market: 'KOSPI' },
  { ticker: '009830', name: '한화솔루션', market: 'KOSPI' },
  { ticker: '000720', name: '현대건설', market: 'KOSPI' },
  { ticker: '028050', name: '삼성엔지니어링', market: 'KOSPI' },
  { ticker: '004020', name: '현대제철', market: 'KOSPI' },
  { ticker: '029780', name: '삼성카드', market: 'KOSPI' },
  { ticker: '000080', name: '하이트진로', market: 'KOSPI' },
  { ticker: '021240', name: '코웨이', market: 'KOSPI' },
  { ticker: '006360', name: 'GS건설', market: 'KOSPI' },
  { ticker: '036460', name: '한국가스공사', market: 'KOSPI' },
  { ticker: '139480', name: '이마트', market: 'KOSPI' },
  { ticker: '004170', name: '신세계', market: 'KOSPI' },
  { ticker: '069960', name: '현대백화점', market: 'KOSPI' },
  { ticker: '001800', name: '오리온홀딩스', market: 'KOSPI' },
  { ticker: '271560', name: '오리온', market: 'KOSPI' },
  { ticker: '005940', name: 'NH투자증권', market: 'KOSPI' },
  { ticker: '071050', name: '한국금융지주', market: 'KOSPI' },
  { ticker: '016360', name: '삼성증권', market: 'KOSPI' },
  { ticker: '035000', name: '메리츠증권', market: 'KOSPI' },
  { ticker: '030000', name: '제일기획', market: 'KOSPI' },
  { ticker: '023530', name: '롯데쇼핑', market: 'KOSPI' },
  { ticker: '000210', name: 'DL', market: 'KOSPI' },
  { ticker: '010060', name: 'OCI홀딩스', market: 'KOSPI' },
  { ticker: '003230', name: '삼양식품', market: 'KOSPI' },
  { ticker: '271940', name: '청담글로벌', market: 'KOSPI' },
  // ── KOSDAQ 주요 종목 ──────────────────────────────────
  { ticker: '035720', name: '카카오', market: 'KOSDAQ' },
  { ticker: '263750', name: '펄어비스', market: 'KOSDAQ' },
  { ticker: '036570', name: '엔씨소프트', market: 'KOSDAQ' },
  { ticker: '251270', name: '넷마블', market: 'KOSDAQ' },
  { ticker: '041510', name: 'SM엔터테인먼트', market: 'KOSDAQ' },
  { ticker: '035900', name: 'JYP엔터테인먼트', market: 'KOSDAQ' },
  { ticker: '122870', name: '와이지엔터테인먼트', market: 'KOSDAQ' },
  { ticker: '068760', name: '셀트리온헬스케어', market: 'KOSDAQ' },
  { ticker: '086900', name: '메디오젠', market: 'KOSDAQ' },
  { ticker: '196170', name: '알테오젠', market: 'KOSDAQ' },
  { ticker: '145020', name: '휴젤', market: 'KOSDAQ' },
  { ticker: '091990', name: '셀트리온제약', market: 'KOSDAQ' },
  { ticker: '039030', name: '이오테크닉스', market: 'KOSDAQ' },
  { ticker: '054040', name: '한국컴퓨터', market: 'KOSDAQ' },
  { ticker: '095340', name: 'ISC', market: 'KOSDAQ' },
  { ticker: '058470', name: '리노공업', market: 'KOSDAQ' },
  { ticker: '357780', name: '솔브레인', market: 'KOSDAQ' },
  { ticker: '053800', name: '안랩', market: 'KOSDAQ' },
  { ticker: '048410', name: '현대바이오', market: 'KOSDAQ' },
  { ticker: '035760', name: 'CJ ENM', market: 'KOSDAQ' },
  { ticker: '028300', name: 'HLB', market: 'KOSDAQ' },
  { ticker: '009420', name: '한올바이오파마', market: 'KOSDAQ' },
  { ticker: '214150', name: '클래시스', market: 'KOSDAQ' },
  { ticker: '950210', name: '프레스티지바이오파마', market: 'KOSDAQ' },
  { ticker: '032640', name: 'LG유플러스', market: 'KOSDAQ' },
  { ticker: '016800', name: '퍼시스', market: 'KOSDAQ' },
  { ticker: '078130', name: '국일제지', market: 'KOSDAQ' },
  { ticker: '060280', name: '큐렉소', market: 'KOSDAQ' },
];

/**
 * 한글 종목명 검색 (포함 검색)
 */
export function searchKoreanStocksLocal(query: string): KoreanStock[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  return KOREAN_STOCKS.filter((s) =>
    s.name.toLowerCase().includes(q) || s.ticker.includes(q)
  ).slice(0, 10);
}
