-- Compass database schema (Supabase Postgres + pgvector)
-- Apply by pasting into Supabase SQL editor, or via psql.

-- Enable pgvector extension for embeddings
CREATE EXTENSION IF NOT EXISTS vector;

-- Targets (companies, deals, securities)
CREATE TABLE IF NOT EXISTS targets (
  id            TEXT PRIMARY KEY,                  -- e.g., 'cava-ipo-2026', 'ba-30y-2056'
  name          TEXT NOT NULL,                     -- e.g., 'Cava Group IPO'
  ticker        TEXT,                              -- e.g., 'CAVA', 'BA'
  cik           TEXT,                              -- SEC CIK if applicable
  business_line TEXT NOT NULL,                     -- 'ecm' | 'dcm' | 'alts'
  asset_class   TEXT,                              -- 'ipos', 'ig-corporate', 'private-equity', etc.
  metadata      JSONB,                             -- flexible additional fields
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_targets_bl     ON targets(business_line);
CREATE INDEX IF NOT EXISTS idx_targets_ticker ON targets(ticker);

-- Documents (filings, news articles, transcripts, model outputs)
CREATE TABLE IF NOT EXISTS documents (
  id                TEXT PRIMARY KEY,
  target_id         TEXT REFERENCES targets(id) ON DELETE CASCADE,
  source            TEXT NOT NULL,                 -- 'sec_edgar', 'msrb', 'fred', 'news_rss', 'compass_model'
  doc_type          TEXT NOT NULL,                 -- '10-K', '10-Q', '8-K', 'S-1', 'news', 'feed', 'diligence', 'memo', 'action', 'monitor'
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

-- Document chunks for RAG retrieval (voyage-3 returns 1024 dims)
CREATE TABLE IF NOT EXISTS chunks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
  chunk_index INT  NOT NULL,
  content     TEXT NOT NULL,
  embedding   VECTOR(1024),
  page_number INT,
  section     TEXT,
  metadata    JSONB,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chunks_document  ON chunks(document_id);
CREATE INDEX IF NOT EXISTS idx_chunks_embedding ON chunks USING hnsw (embedding vector_cosine_ops);

-- Model runs (cached Monte Carlo, LBO, bond pricing, IPO valuation outputs)
CREATE TABLE IF NOT EXISTS model_runs (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_id  TEXT REFERENCES targets(id) ON DELETE CASCADE,
  model_type TEXT NOT NULL,                        -- 'monte_carlo_irr', 'lbo', 'bond_pricing', 'ipo_valuation'
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
  role              TEXT NOT NULL,                 -- 'user' | 'assistant' | 'system'
  content           TEXT NOT NULL,
  agent_activity    JSONB,                         -- which agents fired
  citations         JSONB,                         -- source references
  information_gaps  JSONB,                         -- what wasn't available
  latency_ms        INT,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);

-- Eval results (port from telco capstone harness)
CREATE TABLE IF NOT EXISTS eval_runs (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  test_name                     TEXT NOT NULL,
  metric_groundedness           FLOAT,             -- 0-1
  metric_retrieval_recall_at_5  FLOAT,
  metric_citation_accuracy      FLOAT,
  metric_prompt_injection_blocked BOOLEAN,
  metadata                      JSONB,
  run_at                        TIMESTAMPTZ DEFAULT NOW()
);

-- RLS off for v1 single-user demo (per spec: "Auth: None").
-- When v2 adds auth, enable RLS and add per-role policies instead.
ALTER TABLE targets       DISABLE ROW LEVEL SECURITY;
ALTER TABLE documents     DISABLE ROW LEVEL SECURITY;
ALTER TABLE chunks        DISABLE ROW LEVEL SECURITY;
ALTER TABLE model_runs    DISABLE ROW LEVEL SECURITY;
ALTER TABLE conversations DISABLE ROW LEVEL SECURITY;
ALTER TABLE messages      DISABLE ROW LEVEL SECURITY;
ALTER TABLE eval_runs     DISABLE ROW LEVEL SECURITY;
