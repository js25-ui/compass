/**
 * Temporary diagnostic endpoint — reports which Supabase tables are
 * reachable at runtime and what the actual error is when one fails.
 * Delete after the seeding work is complete.
 */

import { NextRequest } from 'next/server';
import { getSupabaseService } from '@/lib/db/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ProbeResult {
  ok: boolean;
  count?: number | null;
  errorMessage?: string;
  errorCode?: string | null;
  errorHint?: string | null;
}

export async function GET(_req: NextRequest) {
  const envState = {
    has_url: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL),
    url_prefix: (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').slice(0, 30),
    url_length: (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').length,
    has_service_key: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    service_key_length: (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').length,
    has_anon_key: Boolean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
  };

  let clientReady = false;
  let clientError: string | null = null;
  let probes: Record<string, ProbeResult> = {};
  try {
    const sb = getSupabaseService();
    clientReady = true;
    const tables = ['targets', 'documents', 'chunks', 'financial_facts', 'model_runs'];
    for (const table of tables) {
      try {
        const res = await sb.from(table).select('*', { count: 'exact', head: true }).limit(0);
        if (res.error) {
          probes[table] = {
            ok: false,
            errorMessage: res.error.message,
            errorCode: res.error.code ?? null,
            errorHint: res.error.hint ?? null,
          };
        } else {
          probes[table] = { ok: true, count: res.count };
        }
      } catch (err) {
        probes[table] = {
          ok: false,
          errorMessage: err instanceof Error ? err.message : String(err),
        };
      }
    }
  } catch (err) {
    clientError = err instanceof Error ? err.message : String(err);
  }

  return Response.json({
    env: envState,
    clientReady,
    clientError,
    probes,
  });
}
