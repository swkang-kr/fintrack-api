/**
 * Expo Push Notification 발송 클라이언트
 * 공식 문서: https://docs.expo.dev/push-notifications/sending-notifications/
 */

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

export interface PushMessage {
  to: string | string[];
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: 'default' | null;
  badge?: number;
  priority?: 'default' | 'normal' | 'high';
}

export interface PushReceipt {
  status: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: { error?: string };
}

/**
 * 여러 Expo 푸시 메시지를 100개 단위로 배치 전송
 * Expo Push API는 한 번에 최대 100개까지 허용
 */
export async function sendPushNotifications(
  messages: PushMessage[]
): Promise<PushReceipt[]> {
  if (messages.length === 0) return [];

  const chunks = chunkArray(messages, 100);
  const allReceipts: PushReceipt[] = [];

  for (const chunk of chunks) {
    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Accept-Encoding': 'gzip, deflate',
        },
        body: JSON.stringify(chunk),
      });

      if (!res.ok) {
        console.error('[expo-push] HTTP error:', res.status);
        continue;
      }

      const json = await res.json();
      const receipts: PushReceipt[] = json?.data ?? [];
      allReceipts.push(...receipts);
    } catch (err) {
      console.error('[expo-push] fetch error:', err);
    }
  }

  return allReceipts;
}

/** 단일 사용자에게 즉시 알림 전송 (토큰 배열 → 메시지 배열 변환) */
export function buildMessages(
  tokens: string[],
  title: string,
  body: string,
  data?: Record<string, unknown>
): PushMessage[] {
  return tokens.map((to) => ({
    to,
    title,
    body,
    sound: 'default',
    priority: 'high',
    data,
  }));
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}
