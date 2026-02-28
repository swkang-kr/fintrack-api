import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { fetchCurrentRates } from '@/lib/exchange/frankfurter';
import { fetchQuotes } from '@/lib/stocks/yahooFinance';
import { buildMessages, sendPushNotifications } from '@/lib/push/expo';

/**
 * GET /api/alerts/check
 * Vercel Cron이 10분마다 호출 → 알림 조건 체크 후 Expo Push 발송
 *
 * 보안: CRON_SECRET 환경변수로 검증
 * 24시간 쿨다운: 같은 알림이 24시간 내 재발송되지 않도록 방지
 */
export async function GET(request: NextRequest) {
  // ── Cron 인증 (CRON_SECRET 미설정 시 fail-closed) ──────
  const cronSecret = process.env.CRON_SECRET;
  const auth = request.headers.get('Authorization');
  if (!cronSecret || auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createServiceClient();
  const now = new Date();

  try {
    // ── 1. 활성 알림 전체 조회 ────────────────────────────
    const { data: activeAlerts, error: alertsErr } = await supabase
      .from('alerts')
      .select('*')
      .eq('is_active', true);

    if (alertsErr) throw alertsErr;
    if (!activeAlerts || activeAlerts.length === 0) {
      return NextResponse.json({ checked: 0, triggered: 0 });
    }

    // ── 2. 쿨다운 필터링 (24시간 이내 이미 발송된 알림 제외) ──
    const COOLDOWN_MS = 24 * 60 * 60 * 1000;
    const pendingAlerts = activeAlerts.filter((alert) => {
      if (!alert.triggered_at) return true;
      return now.getTime() - new Date(alert.triggered_at).getTime() > COOLDOWN_MS;
    });

    if (pendingAlerts.length === 0) {
      return NextResponse.json({ checked: 0, triggered: 0, reason: 'all in cooldown' });
    }

    // ── 3. 유저별 Push Token 조회 ─────────────────────────
    const userIds = [...new Set(pendingAlerts.map((a) => a.user_id as string))];
    const { data: pushTokenRows } = await supabase
      .from('push_tokens')
      .select('user_id, token')
      .in('user_id', userIds);

    const tokenMap: Record<string, string[]> = {};
    (pushTokenRows ?? []).forEach((row) => {
      if (!tokenMap[row.user_id]) tokenMap[row.user_id] = [];
      tokenMap[row.user_id].push(row.token);
    });

    // ── 4. 환율 데이터 조회 (exchange_rate 알림이 있을 때만) ──
    const exchangeAlerts = pendingAlerts.filter((a) => a.type === 'exchange_rate');
    let currentRates: Record<string, number> = {};
    if (exchangeAlerts.length > 0) {
      try {
        const ratesData = await fetchCurrentRates();
        currentRates = ratesData.rates as unknown as Record<string, number>;
      } catch {
        console.error('[alerts/check] exchange rate fetch failed');
      }
    }

    // ── 5. 주식 데이터 조회 (stock_price 알림이 있을 때만) ──
    const stockAlerts = pendingAlerts.filter((a) => a.type === 'stock_price');
    let stockQuotes: Record<string, { price: number }> = {};
    if (stockAlerts.length > 0) {
      const tickers = [...new Set(stockAlerts.map((a) => a.target as string))];
      try {
        stockQuotes = await fetchQuotes(tickers);
      } catch {
        console.error('[alerts/check] stock quote fetch failed');
      }
    }

    // ── 6. 각 알림 조건 체크 ─────────────────────────────
    const triggeredIds: string[] = [];
    const pushMessages: ReturnType<typeof buildMessages>[number][] = [];

    for (const alert of pendingAlerts) {
      const userTokens = tokenMap[alert.user_id] ?? [];
      if (userTokens.length === 0) continue;

      let currentValue: number | undefined;

      if (alert.type === 'exchange_rate') {
        const currency = (alert.target as string).split('/')[0]; // 'USD' from 'USD/KRW'
        currentValue = currentRates[currency];
      } else if (alert.type === 'stock_price') {
        currentValue = stockQuotes[alert.target]?.price;
      }

      if (currentValue === undefined) continue;

      const threshold: number = parseFloat(alert.threshold);
      const triggered =
        (alert.condition === 'above' && currentValue >= threshold) ||
        (alert.condition === 'below' && currentValue <= threshold);

      if (!triggered) continue;

      triggeredIds.push(alert.id);

      const { title, body } = buildNotificationText(alert, currentValue);
      pushMessages.push(
        ...buildMessages(userTokens, title, body, {
          alertId: alert.id,
          type: alert.type,
          target: alert.target,
        })
      );
    }

    // ── 7. 알림 발송 ──────────────────────────────────────
    if (pushMessages.length > 0) {
      await sendPushNotifications(pushMessages);
    }

    // ── 8. triggered_at 업데이트 ─────────────────────────
    if (triggeredIds.length > 0) {
      await supabase
        .from('alerts')
        .update({ triggered_at: now.toISOString() })
        .in('id', triggeredIds);
    }

    return NextResponse.json({
      checked: pendingAlerts.length,
      triggered: triggeredIds.length,
      sentAt: now.toISOString(),
    });
  } catch (err) {
    console.error('[alerts/check] error:', err);
    return NextResponse.json({ error: '알림 체크 실패' }, { status: 500 });
  }
}

// ── 알림 메시지 생성 ─────────────────────────────────────

interface AlertRow {
  type: string;
  target: string;
  condition: string;
  threshold: number;
}

function buildNotificationText(
  alert: AlertRow,
  currentValue: number
): { title: string; body: string } {
  const conditionText = alert.condition === 'above' ? '이상' : '이하';

  if (alert.type === 'exchange_rate') {
    const currency = alert.target.split('/')[0];
    const formatted = formatRate(currentValue, currency);
    const threshold = formatRate(parseFloat(String(alert.threshold)), currency);
    return {
      title: `📈 ${alert.target} 목표가 달성`,
      body: `${currency}/KRW이 ${threshold} ${conditionText}을 달성했습니다! (현재: ${formatted})`,
    };
  } else {
    const ticker = alert.target.replace(/\.(KS|KQ)$/, '');
    const formatted = formatStockPrice(currentValue);
    const threshold = formatStockPrice(parseFloat(String(alert.threshold)));
    return {
      title: `📊 ${ticker} 목표가 달성`,
      body: `${ticker}이 ${threshold} ${conditionText}을 달성했습니다! (현재: ${formatted})`,
    };
  }
}

function formatRate(value: number, currency: string): string {
  if (currency === 'JPY') return `₩${value.toFixed(4)}`;
  return `₩${value.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

function formatStockPrice(value: number): string {
  return value >= 1000
    ? `₩${Math.round(value).toLocaleString()}`
    : `$${value.toFixed(2)}`;
}
