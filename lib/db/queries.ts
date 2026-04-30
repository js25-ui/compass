import 'server-only';
import { getSupabaseAnon } from './client';
import type {
  ActionPayload,
  DiligencePayload,
  DocumentRow,
  FeedDocPayload,
  Json,
  MemoPayload,
  ModelRunRow,
  MonitorPayload,
  MonteCarloOutputs,
  TargetRow,
} from './types';
import type {
  ActionData,
  BusinessLine,
  DiligenceItem,
  FeedItem,
  Memo,
  Metric,
  MonitorData,
  MonteCarloConfig,
} from '@/lib/demo-data';

function asMetadata<T extends { kind: string }>(metadata: Json, kind: T['kind']): T | null {
  if (
    metadata === null ||
    typeof metadata !== 'object' ||
    Array.isArray(metadata) ||
    metadata.kind !== kind
  ) {
    return null;
  }
  return metadata as unknown as T;
}

export async function dbGetTargetById(id: string): Promise<TargetRow | null> {
  const sb = getSupabaseAnon();
  const { data, error } = await sb.from('targets').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

export async function dbGetTargetsByBL(bl: BusinessLine): Promise<TargetRow[]> {
  const sb = getSupabaseAnon();
  const { data, error } = await sb.from('targets').select('*').eq('business_line', bl).order('name');
  if (error) throw error;
  return data ?? [];
}

async function fetchDocsByType(targetId: string, docType: string): Promise<DocumentRow[]> {
  const sb = getSupabaseAnon();
  const { data, error } = await sb
    .from('documents')
    .select('*')
    .eq('target_id', targetId)
    .eq('doc_type', docType)
    .order('filed_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function dbGetFeed(targetId: string): Promise<FeedItem[]> {
  const docs = await fetchDocsByType(targetId, 'feed');
  return docs
    .map(d => asMetadata<FeedDocPayload>(d.metadata, 'feed')?.item)
    .filter((x): x is FeedItem => Boolean(x));
}

export async function dbGetDiligence(targetId: string): Promise<DiligenceItem[]> {
  const docs = await fetchDocsByType(targetId, 'diligence');
  const payload = docs[0] ? asMetadata<DiligencePayload>(docs[0].metadata, 'diligence') : null;
  return payload?.items ?? [];
}

export async function dbGetMemo(targetId: string): Promise<Memo | null> {
  const docs = await fetchDocsByType(targetId, 'memo');
  return docs[0] ? asMetadata<MemoPayload>(docs[0].metadata, 'memo')?.memo ?? null : null;
}

export async function dbGetAction(targetId: string): Promise<ActionData | null> {
  const docs = await fetchDocsByType(targetId, 'action');
  return docs[0] ? asMetadata<ActionPayload>(docs[0].metadata, 'action')?.data ?? null : null;
}

export async function dbGetMonitor(targetId: string): Promise<MonitorData | null> {
  const docs = await fetchDocsByType(targetId, 'monitor');
  return docs[0] ? asMetadata<MonitorPayload>(docs[0].metadata, 'monitor')?.data ?? null : null;
}

export async function dbGetMetrics(targetId: string): Promise<Metric[]> {
  const docs = await fetchDocsByType(targetId, 'metrics');
  return docs[0]
    ? asMetadata<{ kind: 'metrics'; metrics: Metric[] }>(docs[0].metadata, 'metrics')?.metrics ?? []
    : [];
}

export async function dbGetMonteCarlo(targetId: string): Promise<MonteCarloConfig | null> {
  const sb = getSupabaseAnon();
  const { data, error } = await sb
    .from('model_runs')
    .select('*')
    .eq('target_id', targetId)
    .eq('model_type', 'monte_carlo')
    .order('run_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as ModelRunRow;
  const outputs = row.outputs as unknown as MonteCarloOutputs;
  return outputs.config ?? null;
}
