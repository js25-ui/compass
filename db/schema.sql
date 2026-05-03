-- Compass database schema (Supabase Postgres + pgvector)
-- Apply by pasting into Supabase SQL editor, or via psql.

-- Enable pgvector extension for embeddings
CREATE EXTENSION IF NOT EXISTS vector;

-- Targets (companies, deals, securities — populated on demand by the resolver/ingestor)
CREATE TABLE IF NOT EXISTS targets (
  id              TEXT PRIMARY KEY,                  -- e.g., 'cava-ipo-2026', 'cik-0000320193' for ad-hoc lookups
  name            TEXT NOT NULL,
  ticker          TEXT,
  cik             TEXT,                              -- SEC CIK if applicable
  business_line   TEXT,                              -- 'ecm' | 'dcm' | 'alts' (nullable: not always known up-front)
  asset_class     TEXT,
  entity_type     TEXT,                              -- 'public_company' | 'private_company' | 'sovereign' | 'muni' | 'security'
  status          TEXT NOT NULL DEFAULT 'pending',   -- 'pending' | 'indexed' | 'archived' | 'failed'
  last_queried_at TIMESTAMPTZ,                       -- driven by chat queries; powers the decay policy
  metadata        JSONB,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_targets_bl           ON targets(business_line);
CREATE INDEX IF NOT EXISTS idx_targets_ticker       ON targets(ticker);
CREATE INDEX IF NOT EXISTS idx_targets_status       ON targets(status);
CREATE INDEX IF NOT EXISTS idx_targets_last_queried ON targets(last_queried_at);

-- Documents (filings, news articles, transcripts, model outputs)
CREATE TABLE IF NOT EXISTS documents (
  id                TEXT PRIMARY KEY,
  target_id         TEXT REFERENCES targets(id) ON DELETE CASCADE,
  source            TEXT NOT NULL,                 -- 'sec_edgar', 'msrb', 'fred', 'news_rss', 'gdelt', 'uspto', 'compass_internal'
  doc_type          TEXT NOT NULL,                 -- '10-K', '10-Q', '8-K', 'S-1', 'news', 'patent', 'macro', etc.
  title             TEXT NOT NULL,
  url               TEXT,
  content_full      TEXT,
  filed_at          TIMESTAMPTZ,
  retrieved_at      TIMESTAMPTZ DEFAULT NOW(),
  metadata          JSONB,
  is_primary_source BOOLEAN DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_documents_target ON documents(target_id);
CREATE INDEX IF NOT EXISTS idx_documents_filed  ON documents(filed_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_type   ON documents(doc_type);

-- Document chunks (voyage-3 → 1024 dims)
CREATE TABLE IF NOT EXISTS chunks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
  chunk_index INT  NOT NULL,
  content     TEXT NOT NULL,
  embedding   VECTOR(1024),
  page_number INT,
  section     TEXT,
  metadata    JSONB,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (document_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_chunks_document  ON chunks(document_id);
CREATE INDEX IF NOT EXISTS idx_chunks_embedding ON chunks USING hnsw (embedding vector_cosine_ops);

-- Model runs (cached Monte Carlo, LBO, bond pricing, IPO valuation outputs)
CREATE TABLE IF NOT EXISTS model_runs (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_id  TEXT REFERENCES targets(id) ON DELETE CASCADE,
  model_type TEXT NOT NULL,
  inputs     JSONB NOT NULL,
  outputs    JSONB NOT NULL,
  seed       INT,
  trials     INT,
  run_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_model_runs_target ON model_runs(target_id, model_type);

-- Conversations and messages (Ask Compass)
CREATE TABLE IF NOT EXISTS conversations (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_id  TEXT REFERENCES targets(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS messages (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id   UUID REFERENCES conversations(id) ON DELETE CASCADE,
  role              TEXT NOT NULL,
  content           TEXT NOT NULL,
  agent_activity    JSONB,
  citations         JSONB,
  information_gaps  JSONB,
  latency_ms        INT,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);

-- Ingest run tracking (per-source per-target; powers the /admin/ingest page)
CREATE TABLE IF NOT EXISTS ingest_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_id       TEXT REFERENCES targets(id) ON DELETE CASCADE,
  source          TEXT NOT NULL,                 -- 'sec_edgar', 'fred', 'gdelt', 'news_rss', 'uspto'
  status          TEXT NOT NULL,                 -- 'success' | 'partial' | 'error'
  documents_added INT DEFAULT 0,
  chunks_added    INT DEFAULT 0,
  error           TEXT,
  duration_ms     INT,
  ran_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ingest_runs_target ON ingest_runs(target_id, ran_at DESC);
CREATE INDEX IF NOT EXISTS idx_ingest_runs_source ON ingest_runs(source, ran_at DESC);

-- Per-source incremental cursors (used by background discovery scrapers)
CREATE TABLE IF NOT EXISTS ingest_cursors (
  source     TEXT PRIMARY KEY,                   -- 'edgar' | 'news_rss' | 'gdelt'
  last_cursor TEXT,                              -- timestamp or token, source-specific
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Tasks: end-to-end work units (clarify → gather → model → deliver)
CREATE TABLE IF NOT EXISTS tasks (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_query               TEXT NOT NULL,
  target_id                TEXT REFERENCES targets(id),
  task_type                TEXT,                          -- 'pitch_book' | 'ic_memo' | 'bond_pricing' | 'lbo_analysis' | 'chat_answer'
  scope                    JSONB,                         -- clarified scope params (comp count, time window, etc.)
  stage                    TEXT NOT NULL DEFAULT 'clarify',-- 'clarify' | 'gather' | 'model' | 'deliver' | 'done'
  inputs_gathered          JSONB,
  models_run               JSONB,
  deliverables_generated   JSONB,
  conversation_id          UUID,
  created_at               TIMESTAMPTZ DEFAULT NOW(),
  updated_at               TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tasks_target  ON tasks(target_id);
CREATE INDEX IF NOT EXISTS idx_tasks_stage   ON tasks(stage);
CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at DESC);

-- Financial facts cache: parsed XBRL values keyed by target + metric + period.
-- Models pull from this table for fast retrieval; XBRL only re-parsed when a
-- required (target, metric, period) is missing. Hot path for LBO / IPO / bond.
CREATE TABLE IF NOT EXISTS financial_facts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_id         TEXT REFERENCES targets(id) ON DELETE CASCADE,
  metric            TEXT NOT NULL,            -- 'revenue' | 'ebitda' | 'capex' | 'long_term_debt' | etc.
  value             NUMERIC,
  period            TEXT,                     -- 'LTM' | 'FY2024' | 'Q1_2026' | 'TTM_2026Q1'
  source_filing_id  TEXT,                     -- accession number or document_id
  filed_at          TIMESTAMPTZ,
  retrieved_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (target_id, metric, period)
);

CREATE INDEX IF NOT EXISTS idx_facts_target_metric ON financial_facts(target_id, metric);
CREATE INDEX IF NOT EXISTS idx_facts_target        ON financial_facts(target_id);

-- Generated documents (IC memos, pitch decks)
CREATE TABLE IF NOT EXISTS generated_documents (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_id           TEXT REFERENCES targets(id),
  conversation_id     UUID,
  doc_type            TEXT NOT NULL,                 -- 'ic_memo' | 'pitch_deck'
  format              TEXT NOT NULL,                 -- 'pdf' | 'pptx'
  title               TEXT NOT NULL,
  storage_path        TEXT NOT NULL,                 -- path within the 'generated-documents' bucket
  metadata            JSONB,
  generation_time_ms  INT,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gen_docs_target  ON generated_documents(target_id);
CREATE INDEX IF NOT EXISTS idx_gen_docs_conv    ON generated_documents(conversation_id);
CREATE INDEX IF NOT EXISTS idx_gen_docs_created ON generated_documents(created_at DESC);

-- Eval results (port from telco capstone harness)
CREATE TABLE IF NOT EXISTS eval_runs (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  test_name                     TEXT NOT NULL,
  metric_groundedness           FLOAT,
  metric_retrieval_recall_at_5  FLOAT,
  metric_citation_accuracy      FLOAT,
  metric_prompt_injection_blocked BOOLEAN,
  metadata                      JSONB,
  run_at                        TIMESTAMPTZ DEFAULT NOW()
);

-- RLS off for v1 single-user demo (per spec: "Auth: None").
-- When v2 adds auth, enable RLS and add per-role policies instead.
ALTER TABLE targets        DISABLE ROW LEVEL SECURITY;
ALTER TABLE documents      DISABLE ROW LEVEL SECURITY;
ALTER TABLE chunks         DISABLE ROW LEVEL SECURITY;
ALTER TABLE model_runs     DISABLE ROW LEVEL SECURITY;
ALTER TABLE conversations  DISABLE ROW LEVEL SECURITY;
ALTER TABLE messages       DISABLE ROW LEVEL SECURITY;
ALTER TABLE ingest_runs    DISABLE ROW LEVEL SECURITY;
ALTER TABLE ingest_cursors DISABLE ROW LEVEL SECURITY;
ALTER TABLE eval_runs      DISABLE ROW LEVEL SECURITY;
ALTER TABLE generated_documents DISABLE ROW LEVEL SECURITY;
ALTER TABLE tasks               DISABLE ROW LEVEL SECURITY;
ALTER TABLE financial_facts     DISABLE ROW LEVEL SECURITY;
