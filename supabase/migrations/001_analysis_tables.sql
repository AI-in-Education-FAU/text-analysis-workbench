-- Adds what the analysis app needs on top of the existing schema.
-- Safe to run more than once. Run it in the Supabase SQL editor.

create extension if not exists pgcrypto;

-- One row per (task, method) execution, so every result can be traced to its settings.
create table if not exists public.analysis_runs (
  id uuid primary key default gen_random_uuid(),
  task text not null,            -- sentiment | stance | topics | emotion | codebook
  method text not null,          -- e.g. vader, openai, lda
  method_name text,
  target_type text not null check (target_type in ('articles', 'comments')),
  options jsonb not null default '{}'::jsonb,   -- target, labels, models, seed, run metadata
  item_count integer,
  summary jsonb,                 -- label counts, mean confidence, discovered topics, model ids
  created_at timestamptz not null default now()
);

-- Existing result tables: link rows to a run, a method and (optionally) a comment.
alter table public.sentiment_results
  add column if not exists method text,
  add column if not exists run_id uuid references public.analysis_runs(id) on delete cascade,
  add column if not exists comment_id bigint references public.comments(id),
  add column if not exists score double precision,
  add column if not exists rationale text,
  add column if not exists evidence text;

alter table public.stance_results
  add column if not exists method text,
  add column if not exists run_id uuid references public.analysis_runs(id) on delete cascade,
  add column if not exists comment_id bigint references public.comments(id),
  add column if not exists target text,
  add column if not exists rationale text,
  add column if not exists evidence text;

alter table public.topic_results
  add column if not exists method text,
  add column if not exists run_id uuid references public.analysis_runs(id) on delete cascade,
  add column if not exists comment_id bigint references public.comments(id),
  add column if not exists keywords text[],
  add column if not exists rationale text,
  add column if not exists evidence text;

-- Emotion detection and custom codebook classification results.
create table if not exists public.label_results (
  id bigint generated always as identity primary key,
  run_id uuid references public.analysis_runs(id) on delete cascade,
  task text not null,
  codebook text,
  article_id bigint not null references public.articles(id),
  comment_id bigint references public.comments(id),
  label text,
  confidence double precision check (confidence is null or (confidence >= 0 and confidence <= 1)),
  method text,
  rationale text,
  evidence text,
  created_at timestamptz not null default now()
);

create index if not exists sentiment_results_run_idx on public.sentiment_results(run_id);
create index if not exists stance_results_run_idx on public.stance_results(run_id);
create index if not exists topic_results_run_idx on public.topic_results(run_id);
create index if not exists label_results_run_idx on public.label_results(run_id);
create index if not exists comments_article_idx on public.comments(article_id);

-- The analysis server uses the service-role key, which bypasses RLS.
-- The browser uses the publishable (anon) key to browse data, so allow read-only access
-- to the source tables. Remove these if your data must not be publicly readable and
-- add authenticated-only policies instead.
alter table public.articles enable row level security;
alter table public.comments enable row level security;

drop policy if exists "read articles" on public.articles;
create policy "read articles" on public.articles for select to anon, authenticated using (true);

drop policy if exists "read comments" on public.comments;
create policy "read comments" on public.comments for select to anon, authenticated using (true);
