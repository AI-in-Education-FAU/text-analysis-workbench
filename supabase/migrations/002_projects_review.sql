-- Proposal requirements: projects (FR-2/3/30), stakeholder classification (FR-19..21),
-- conversational stance (FR-17A), status/flags (FR-15/16/22), separate validation decisions
-- (FR-28/29), reference labels for evaluation (FR-23) and authenticated access (FR-1).
-- Run after 001_analysis_tables.sql. Safe to run more than once.

-- Projects ---------------------------------------------------------------------------------
create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  description text,
  config jsonb not null default '{}'::jsonb,  -- keywords, sources, authors, date range, analyses, threshold
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists projects_owner_idx on public.projects(owner_id);

-- Runs: project, researcher, status, method version, timing --------------------------------
alter table public.analysis_runs
  add column if not exists project_id uuid references public.projects(id) on delete set null,
  add column if not exists created_by uuid references auth.users(id) on delete set null,
  add column if not exists status text not null default 'completed',  -- completed | partial | failed
  add column if not exists error text,
  add column if not exists method_version text,
  add column if not exists duration_ms integer,
  add column if not exists updated_at timestamptz;
create index if not exists analysis_runs_project_idx on public.analysis_runs(project_id);

-- Per-result status, review flags and errors on every result table --------------------------
alter table public.sentiment_results
  add column if not exists status text not null default 'ok',   -- ok | failed | ineligible
  add column if not exists error text,
  add column if not exists flags text[] not null default '{}';  -- low_confidence | conflict | failed

alter table public.stance_results
  add column if not exists status text not null default 'ok',
  add column if not exists error text,
  add column if not exists flags text[] not null default '{}',
  add column if not exists target_type text,          -- article | comment (conversational stance)
  add column if not exists target_id bigint;

alter table public.topic_results
  add column if not exists status text not null default 'ok',
  add column if not exists error text,
  add column if not exists flags text[] not null default '{}';

alter table public.label_results
  add column if not exists status text not null default 'ok',
  add column if not exists error text,
  add column if not exists flags text[] not null default '{}';

-- Author/stakeholder classification uses the existing classification_results table.
alter table public.classification_results
  add column if not exists method text,
  add column if not exists run_id uuid references public.analysis_runs(id) on delete cascade,
  add column if not exists comment_id bigint references public.comments(id),
  add column if not exists rationale text,
  add column if not exists evidence text,
  add column if not exists status text not null default 'ok',
  add column if not exists error text,
  add column if not exists flags text[] not null default '{}';
create index if not exists classification_results_run_idx on public.classification_results(run_id);

-- Result tables may now hold failed/ineligible rows without a label (already nullable).

-- Researcher validation decisions, kept separate from machine output (FR-28, FR-29) ----------
create table if not exists public.validation_decisions (
  id bigint generated always as identity primary key,
  run_id uuid references public.analysis_runs(id) on delete cascade,
  task text not null,
  result_table text not null,
  result_id bigint not null,
  item_type text not null check (item_type in ('article', 'comment')),
  item_id bigint not null,
  decision text not null check (decision in ('approve', 'correct', 'reject', 'exclude')),
  original_label text,
  corrected_label text,
  note text,
  reviewer_id uuid references auth.users(id) on delete set null,
  reviewer_email text,
  created_at timestamptz not null default now()
);
create index if not exists validation_decisions_result_idx on public.validation_decisions(result_table, result_id);
create index if not exists validation_decisions_run_idx on public.validation_decisions(run_id);

-- Human reference sample (team or partner labels) used for evaluation (FR-23) ---------------
create table if not exists public.reference_labels (
  id bigint generated always as identity primary key,
  project_id uuid references public.projects(id) on delete set null,
  task text not null,
  item_type text not null check (item_type in ('article', 'comment')),
  item_id bigint not null,
  article_id bigint references public.articles(id),
  label text not null,
  original_label text,                       -- partner's own label before mapping
  label_source text not null default 'team', -- team | partner
  annotator text not null default '',
  guide_version text not null default 'v1',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (task, item_type, item_id, label_source, annotator, guide_version)
);
create index if not exists reference_labels_task_idx on public.reference_labels(task, item_type);

create index if not exists comments_parent_idx on public.comments(parent_comment_id);

-- Access control -------------------------------------------------------------------------------
-- The analysis server uses the service-role key (bypasses RLS) and checks the user's JWT itself.
-- New tables get RLS with no browser policies, so they are reachable only through the server.
alter table public.projects enable row level security;
alter table public.validation_decisions enable row level security;
alter table public.reference_labels enable row level security;
alter table public.analysis_runs enable row level security;

-- FR-1: only signed-in researchers may browse source records from the browser.
drop policy if exists "read articles" on public.articles;
create policy "read articles" on public.articles for select to authenticated using (true);
drop policy if exists "read comments" on public.comments;
create policy "read comments" on public.comments for select to authenticated using (true);
