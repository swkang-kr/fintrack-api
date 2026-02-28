export default function Home() {
  const endpoints = [
    {
      method: 'GET',
      path: '/api/exchange/rates',
      desc: '현재 환율 (USD/EUR/JPY/CNY → KRW)',
      example: '/api/exchange/rates',
    },
    {
      method: 'GET',
      path: '/api/exchange/history',
      desc: '환율 히스토리 (30일)',
      example: '/api/exchange/history?pair=USD/KRW&days=30',
    },
    {
      method: 'GET',
      path: '/api/market/indices',
      desc: '시장 지수 (KOSPI/KOSDAQ/S&P500/NASDAQ)',
      example: '/api/market/indices',
    },
    {
      method: 'GET',
      path: '/api/stocks/quote',
      desc: '주식 현재가 — 국내: KIS 실시간, 해외: Yahoo Finance',
      example: '/api/stocks/quote?tickers=005930.KS,AAPL',
    },
    {
      method: 'GET',
      path: '/api/stocks/search',
      desc: '종목 검색',
      example: '/api/stocks/search?q=삼성전자',
    },
    {
      method: 'GET',
      path: '/api/stocks/fundamentals',
      desc: '기업 펀더멘털 — 국내: KIS(PER/EPS/PBR/시총), 해외: Yahoo',
      example: '/api/stocks/fundamentals?ticker=005930.KS',
    },
    {
      method: 'POST',
      path: '/api/alerts/register-token',
      desc: '푸시 토큰 등록 (JWT 인증 필요)',
      example: null,
    },
    {
      method: 'GET',
      path: '/api/alerts/check',
      desc: '알림 체크 Cron (CRON_SECRET 필요)',
      example: null,
    },
    {
      method: 'POST',
      path: '/api/ai/analyze',
      desc: 'AI 포트폴리오 분석 (JWT 인증, 5회/일)',
      example: null,
    },
    {
      method: 'GET',
      path: '/api/portfolio/snapshot',
      desc: '포트폴리오 스냅샷 Cron (CRON_SECRET 필요)',
      example: null,
    },
  ];

  const methodColor: Record<string, string> = {
    GET: '#34A853',
    POST: '#1A73E8',
  };

  return (
    <html lang="ko">
      <head>
        <title>FinTrack API</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <style>{`
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                 background: #F8F9FA; color: #1A1A1A; }
          .container { max-width: 860px; margin: 0 auto; padding: 40px 24px 80px; }
          .header { margin-bottom: 40px; }
          .badge { display: inline-block; background: #E8F0FE; color: #1A73E8;
                   font-size: 12px; font-weight: 600; padding: 4px 10px;
                   border-radius: 20px; margin-bottom: 12px; }
          h1 { font-size: 32px; font-weight: 800; color: #1A73E8; letter-spacing: -1px; }
          .subtitle { font-size: 15px; color: #5F6368; margin-top: 6px; }
          .section-title { font-size: 13px; font-weight: 700; color: #9AA0A6;
                           text-transform: uppercase; letter-spacing: 0.5px;
                           margin: 32px 0 12px; }
          .card { background: #fff; border-radius: 12px; border: 1px solid #E8EAED;
                  overflow: hidden; margin-bottom: 8px; }
          .endpoint { display: flex; align-items: flex-start; gap: 14px;
                      padding: 14px 18px; }
          .endpoint:hover { background: #F8F9FA; }
          .method { font-size: 11px; font-weight: 700; padding: 3px 8px;
                    border-radius: 6px; color: #fff; min-width: 42px;
                    text-align: center; margin-top: 2px; flex-shrink: 0; }
          .endpoint-info { flex: 1; }
          .path { font-size: 14px; font-weight: 600; color: #1A1A1A;
                  font-family: 'SF Mono', 'Fira Code', monospace; }
          .desc { font-size: 13px; color: #5F6368; margin-top: 3px; }
          .example-link { display: inline-block; margin-top: 6px; font-size: 12px;
                          color: #1A73E8; text-decoration: none; font-family: monospace;
                          background: #E8F0FE; padding: 2px 8px; border-radius: 4px; }
          .example-link:hover { background: #D2E3FC; }
          .divider { height: 1px; background: #F1F3F4; margin: 0 18px; }
          .note { background: #FEF7E0; border: 1px solid #FDD663; border-radius: 10px;
                  padding: 14px 18px; font-size: 13px; color: #856404; margin-top: 24px; }
          .note strong { font-weight: 700; }
          .sources { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 4px; }
          .source-tag { font-size: 11px; background: #F1F3F4; border-radius: 4px;
                        padding: 2px 6px; color: #5F6368; font-weight: 600; }
        `}</style>
      </head>
      <body>
        <div className="container">
          <div className="header">
            <div className="badge">API Server</div>
            <h1>FinTrack API</h1>
            <p className="subtitle">환율·주식 포트폴리오 트래커 백엔드 — Next.js 16 / Vercel</p>
          </div>

          <div className="section-title">데이터 소스</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
            {[
              { label: 'KIS (한국투자증권)', desc: '국내주식 실시간' },
              { label: 'Frankfurter', desc: '환율 (무료)' },
              { label: 'BOK ECOS', desc: '환율 (한국은행, 선택)' },
              { label: 'Yahoo Finance', desc: '해외주식 / fallback' },
              { label: 'Claude Haiku', desc: 'AI 포트폴리오 분석' },
            ].map(({ label, desc }) => (
              <div key={label} style={{
                background: '#fff', border: '1px solid #E8EAED', borderRadius: 8,
                padding: '8px 14px', fontSize: 13,
              }}>
                <strong>{label}</strong>
                <span style={{ color: '#9AA0A6', marginLeft: 6 }}>{desc}</span>
              </div>
            ))}
          </div>

          <div className="section-title">엔드포인트 ({endpoints.length}개)</div>
          <div className="card">
            {endpoints.map((ep, i) => (
              <div key={ep.path}>
                <div className="endpoint">
                  <span
                    className="method"
                    style={{ background: methodColor[ep.method] ?? '#9AA0A6' }}
                  >
                    {ep.method}
                  </span>
                  <div className="endpoint-info">
                    <div className="path">{ep.path}</div>
                    <div className="desc">{ep.desc}</div>
                    {ep.example && (
                      <a className="example-link" href={ep.example}>
                        {ep.example}
                      </a>
                    )}
                  </div>
                </div>
                {i < endpoints.length - 1 && <div className="divider" />}
              </div>
            ))}
          </div>

          <div className="note">
            <strong>⚠ 주의</strong> — 이 서버는 API 전용입니다. 인증이 필요한 엔드포인트는
            Expo 앱에서 Bearer JWT를 헤더에 포함해야 합니다. Cron 엔드포인트는{' '}
            <code>CRON_SECRET</code> 환경변수 설정 필요.
          </div>
        </div>
      </body>
    </html>
  );
}
