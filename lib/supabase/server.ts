import { createClient } from '@supabase/supabase-js';

/**
 * 서버 전용 Supabase 클라이언트 (Service Role Key)
 * RLS를 우회하므로 API Route 서버 사이드에서만 사용할 것
 */
export function createServiceClient() {
  return createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_KEY!,
    {
      db: { schema: 'fintrack' },
      auth: { autoRefreshToken: false, persistSession: false },
    }
  );
}

/** JWT Bearer 토큰으로 사용자를 검증하고 user를 반환 */
export async function getUserFromRequest(
  request: Request
): Promise<{ id: string; email: string } | null> {
  const authHeader = request.headers.get('Authorization');
  const jwt = authHeader?.replace('Bearer ', '').trim();
  if (!jwt) return null;

  const client = createServiceClient();
  const { data: { user }, error } = await client.auth.getUser(jwt);
  if (error || !user) return null;

  return { id: user.id, email: user.email ?? '' };
}
