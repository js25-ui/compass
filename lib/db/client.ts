import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './types';

export function hasSupabaseEnv(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}

export function getSupabaseAnon(): SupabaseClient<Database> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error('Supabase anon env vars are not set');
  }
  return createClient<Database>(url, key, { auth: { persistSession: false } });
}

export function getSupabaseService(): SupabaseClient<Database> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('Supabase service-role env vars are not set');
  }
  return createClient<Database>(url, key, { auth: { persistSession: false } });
}
