import type {
  ActionData,
  DiligenceItem,
  FeedItem,
  Memo,
  Metric,
  MonitorData,
  MonteCarloConfig,
} from '@/lib/demo-data';

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export interface TargetRow {
  id: string;
  name: string;
  ticker: string | null;
  cik: string | null;
  business_line: string;
  asset_class: string | null;
  metadata: Json;
  created_at: string;
  updated_at: string;
}

export interface DocumentRow {
  id: string;
  target_id: string | null;
  source: string;
  doc_type: string;
  title: string;
  url: string | null;
  content_full: string | null;
  filed_at: string | null;
  retrieved_at: string;
  metadata: Json;
  is_primary_source: boolean;
}

export interface ChunkRow {
  id: string;
  document_id: string | null;
  chunk_index: number;
  content: string;
  embedding: number[] | null;
  page_number: number | null;
  section: string | null;
  metadata: Json;
  created_at: string;
}

export interface ModelRunRow {
  id: string;
  target_id: string | null;
  model_type: string;
  inputs: Json;
  outputs: Json;
  seed: number | null;
  trials: number | null;
  run_at: string;
}

interface TargetInsert {
  id: string;
  name: string;
  ticker?: string | null;
  cik?: string | null;
  business_line: string;
  asset_class?: string | null;
  metadata?: Json;
  created_at?: string;
  updated_at?: string;
}

interface DocumentInsert {
  id: string;
  target_id?: string | null;
  source: string;
  doc_type: string;
  title: string;
  url?: string | null;
  content_full?: string | null;
  filed_at?: string | null;
  retrieved_at?: string;
  metadata?: Json;
  is_primary_source?: boolean;
}

interface ChunkInsert {
  id?: string;
  document_id?: string | null;
  chunk_index: number;
  content: string;
  embedding?: number[] | null;
  page_number?: number | null;
  section?: string | null;
  metadata?: Json;
  created_at?: string;
}

interface ModelRunInsert {
  id?: string;
  target_id?: string | null;
  model_type: string;
  inputs: Json;
  outputs: Json;
  seed?: number | null;
  trials?: number | null;
  run_at?: string;
}

export interface Database {
  public: {
    Tables: {
      targets: {
        Row: TargetRow;
        Insert: TargetInsert;
        Update: Partial<TargetRow>;
        Relationships: [];
      };
      documents: {
        Row: DocumentRow;
        Insert: DocumentInsert;
        Update: Partial<DocumentRow>;
        Relationships: [
          {
            foreignKeyName: 'documents_target_id_fkey';
            columns: ['target_id'];
            isOneToOne: false;
            referencedRelation: 'targets';
            referencedColumns: ['id'];
          },
        ];
      };
      chunks: {
        Row: ChunkRow;
        Insert: ChunkInsert;
        Update: Partial<ChunkRow>;
        Relationships: [
          {
            foreignKeyName: 'chunks_document_id_fkey';
            columns: ['document_id'];
            isOneToOne: false;
            referencedRelation: 'documents';
            referencedColumns: ['id'];
          },
        ];
      };
      model_runs: {
        Row: ModelRunRow;
        Insert: ModelRunInsert;
        Update: Partial<ModelRunRow>;
        Relationships: [
          {
            foreignKeyName: 'model_runs_target_id_fkey';
            columns: ['target_id'];
            isOneToOne: false;
            referencedRelation: 'targets';
            referencedColumns: ['id'];
          },
        ];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}

// JSONB payload shapes used by seed + queries
export interface FeedDocPayload {
  kind: 'feed';
  item: FeedItem;
}

export interface DiligencePayload {
  kind: 'diligence';
  items: DiligenceItem[];
}

export interface MemoPayload {
  kind: 'memo';
  memo: Memo;
}

export interface ActionPayload {
  kind: 'action';
  data: ActionData;
}

export interface MonitorPayload {
  kind: 'monitor';
  data: MonitorData;
}

export interface MetricsPayload {
  kind: 'metrics';
  metrics: Metric[];
}

export interface MonteCarloOutputs {
  kind: 'monte_carlo';
  config: MonteCarloConfig;
}
