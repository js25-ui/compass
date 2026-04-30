# Compass database setup

Compass uses Supabase Postgres with the `pgvector` extension. The frontend reads from the DB when env vars are present and falls back to `lib/demo-data.ts` otherwise — so the app works even before Supabase is provisioned.

## Setup

1. **Create a Supabase project** at https://supabase.com (free tier is fine).
2. **Apply the schema.** In the Supabase dashboard, open SQL Editor and paste the contents of `db/schema.sql`. Run it once.
3. **Copy `.env.example` to `.env.local`** in the repo root, then fill in:
   - `NEXT_PUBLIC_SUPABASE_URL` — Project Settings → API → URL
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` — Project Settings → API → anon public key
   - `SUPABASE_SERVICE_ROLE_KEY` — Project Settings → API → service_role key (server-only, never ship to client)
   - `VOYAGE_API_KEY` — *optional*. If set, the seed script computes real `voyage-3` embeddings (1024 dims). If unset, chunks get zero-vector placeholders.
4. **Seed the demo data.** From the repo root:
   ```bash
   pnpm seed
   ```
   This populates the 5 demo targets (Cava, Boeing, NYC GO Bonds, Blackstone, Prologis) with their feed documents, diligence/memo/monitor/action records, and a Monte Carlo run each.

## What the seed populates

For each demo target:
- One `targets` row
- 4 `documents` of type `feed` (with the v9 demo feed items as JSONB metadata)
- 4 `chunks` (one per feed doc, with `voyage-3` embedding if the API key is set)
- 5 flat `documents` (`diligence`, `memo`, `action`, `monitor`, `metrics`) carrying their JSONB payloads
- 1 `model_runs` row of type `monte_carlo` with seed=42, trials=10000

The seed is idempotent: `pnpm seed` upserts targets, then deletes and re-inserts demo documents and model runs.

## Verifying

Once seeded, hit `http://localhost:3000/workstation/ecm/cava-ipo-2026` — the page now reads from Supabase. To prove it's coming from the DB, change a row in `documents.metadata` via the Supabase table editor and refresh.

## Schema reference

See `db/schema.sql`. Tables: `targets`, `documents`, `chunks` (with HNSW index on `embedding`), `model_runs`, `conversations`, `messages`, `eval_runs`.
