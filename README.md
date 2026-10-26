# Text Analysis Workbench

A research tool for analysing the articles and comments stored in Supabase. Researchers define a project, explore the data, run several NLP methods side by side (lexicon/rule baselines, Hugging Face transformers, OpenAI LLMs, LDA/NMF), compare them with human reference labels, review and correct results, and export the outputs.

| Folder | What it is |
|---|---|
| `client/` | React + Vite website. Signs in with Supabase Auth and reads articles/comments with the publishable key. |
| `server/` | Node.js + Express analysis API. Holds the secret keys, runs analysis jobs and saves results to Supabase. |
| `supabase/migrations/` | SQL for the analysis, project, review and reference-label tables and row-level security. |

## Setup

1. **Install** (Node 20+): `npm install`, then `npm run install:all`.
2. **Database**: in the Supabase SQL editor, run `supabase/migrations/001_analysis_tables.sql`, then `002_projects_review.sql`.
   Migration 002 makes articles and comments readable only by signed-in users.
3. **Users**: enable Email auth (Authentication → Providers). Researchers can then sign up on the login page, or you can invite them from the dashboard.
4. **Server env**: copy `server/.env.example` to `server/.env` and set:
   - `SUPABASE_SERVICE_ROLE_KEY` (required to load text and save results; never put it in the client)
   - `OPENAI_API_KEY` (optional, enables the LLM methods)
   - `HF_TOKEN` (optional, enables the Hugging Face models)
5. **Client env**: copy `client/.env.example` to `client/.env` and set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`.
   Save it as UTF-8 **without BOM**, otherwise Vite will not see the first variable.
6. **Run**: `npm run dev` starts the API on <http://localhost:3001> and the website on <http://localhost:5173>.
7. **Test**: `npm test` (server unit tests). For the end-to-end tests, see [Testing](#testing).

Methods whose provider key is missing are shown as unavailable rather than failing.

## Testing

| Command | What it checks |
| --- | --- |
| `npm test` | Server unit tests: every analysis method and the proposal requirements, offline (`server/test`). |
| `npm run test:e2e` | End-to-end tests of the live website and API, run in a real Chrome browser with Playwright (`e2e/`). |
| `npm run test:all` | Both of the above. |

Run the end-to-end tests after every deploy, or whenever you change the website or server.

**One-time setup**

1. `npm --prefix e2e install` (this also downloads Chromium).
2. Copy `e2e/.env.example` to `e2e/.env` and set `E2E_SUPABASE_SERVICE_ROLE_KEY`.

The suite uses the key only to create a throw-away `e2e-…@example.com` user and to delete it afterwards. The key stays on your machine because `.env` is git-ignored.

**What the end-to-end suite covers** (about 50 tests, roughly 2 minutes)

- **API** (`e2e/tests/api.spec.js`):
  - Configuration and services, sign-in protection, CORS, and input validation.
  - Project create, read, update and delete, with field errors.
  - Every local method on real data (AFINN, VADER, cue-lexicon stance, stakeholder rules, LDA and NMF with coherence and seed reproducibility, target stance).
  - The Hugging Face models.
  - Saved runs, the results table and summary, and review decisions.
  - Per-user isolation.
  - Corpus keywords and concordance.
- **Website, signed out** (`e2e/tests/ui-public.spec.js`): login page, deep links, dark-theme toggle and persistence, wrong-password message, forgot-password form, sign-up, and the session surviving a reload.
- **Website, full workflow** (`e2e/tests/ui-workflow.spec.js`), run in order:
  1. Dashboard counts.
  2. Create a project (including its validation errors), then edit it.
  3. Explore scoped to the project and select comments.
  4. Analyze with AFINN and VADER, saved; check the results table and charts.
  5. LDA topics.
  6. Saved runs list and run detail.
  7. Approve a result on the Review page.
  8. Corpus keywords and concordance.
  9. Method guide and theme.
  10. Delete the runs and the project, then sign out.

Everything the tests create is deleted at the end, including after a failed or aborted run.

**Options** (environment variables or `e2e/.env`)

| Variable | Default | Purpose |
| --- | --- | --- |
| `E2E_BASE_URL` | Netlify site | Website to test. Use `http://localhost:5173` while `npm run dev` is running. |
| `E2E_API_URL` | Render API | API to test. Use `http://localhost:3001` locally. |
| `E2E_OPENAI` | off | `1` also tests the OpenAI methods. This uses paid credits. |
| `E2E_SKIP_HF` | off | `1` skips the Hugging Face tests, for example when the free quota has run out. |

**Useful commands** (run inside `e2e/`)

- `npm run test:api`: API tests only.
- `npm run test:ui`: website tests only.
- `npm run test:headed`: watch the browser while it runs.
- `npm run report`: open the HTML report, which includes screenshots and traces of any failures.

## Workflow

1. **Projects**: save keywords, topics, authors, sources, source types, a date range, the default unit (articles or comments), planned analyses and the low-confidence threshold.
2. **Explore**: filter articles or comments (optionally restricted to the active project), read items and select a sample. Author names are pseudonymised by default.
3. **Corpus tools**: keywords, concordance and an AI overview.
4. **Analyze**: run several methods on the same items and compare them in the results view (agreement, κ, evaluation against reference labels, topic coherence). You can retry failed items.
5. **Reference labels**: import a CSV of human labels or code items in the results view. A sample of 200–300 is recommended. Team and partner coders are kept separate so you can compute κ.
6. **Review & validate**: filter saved results by task, method, label, flag, confidence, source, date or author; approve, correct, reject or exclude each one. Decisions are stored separately, so machine output is never overwritten.
7. **Export**: download results as CSV, JSON or XML, or a full JSON report, including the final label and its source.

## Analysis tasks

| Task | Methods |
|---|---|
| Sentiment | AFINN, VADER (baselines), RoBERTa, DistilBERT SST-2, OpenAI |
| Conversational stance (comment → parent) | Cue-word baseline, NLI zero-shot, OpenAI. Comments without a parent are reported as *ineligible*. |
| Stakeholder classification | Self-identification rules (baseline), zero-shot NLI, OpenAI |
| Topic modelling | LDA, NMF (baselines, with UMass coherence), zero-shot, OpenAI |
| Stance toward a proposition | Target-sentence sentiment (baseline), zero-shot NLI, OpenAI |
| Emotion | DistilRoBERTa-emotion, zero-shot NLI, OpenAI |
| Custom codebook | Zero-shot NLI, OpenAI |

Each result has a label, a confidence score, optional rationale and evidence (LLM evidence quotes are checked against the text), and flags:

- `low_confidence`: the confidence is below the threshold.
- `conflict`: the methods disagree on the item.
- `failed`: the method errored on the item.

Each run records its method, version, model, options, status and timing.

## Deployment

The API keeps running analysis jobs in memory. Deploy it as **one always-on Node process**, not as serverless functions. If `client/dist` exists, the Express server also serves the website, so one service is enough.

**Single service (Render, Railway, Fly.io, or a VPS):**

1. Push the repository to GitHub, then create a Node web service from it, with the repository root as the root directory.
2. Set the build command to `npm run build:prod` and the start command to `npm start`.
3. Set these environment variables:
   - From `server/.env.example`: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`, `HF_TOKEN`
   - `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`, which are baked in at build time
   - `CORS_ORIGIN` set to your site URL
4. In Supabase → Authentication → URL Configuration, set the Site URL and Redirect URLs to the deployed URL, so confirmation and password-reset links work.

**Split hosting:** host `client/` as a static site on Vercel, Netlify or Cloudflare Pages.

- Set the build command to `npm run build`, the output directory to `dist`, and add an SPA rewrite of `/*` to `/index.html`.
- Set `VITE_API_URL` to the API's URL.
- Host `server/` separately as above, with `CORS_ORIGIN` set to the static site's URL.

**Netlify (website) + Render (API):** the repository includes `netlify.toml` and `render.yaml`.

1. Push the repository to GitHub.
2. On Render, choose New → Blueprint and pick the repository. It reads `render.yaml`.
   - Fill in `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY` and `HF_TOKEN`.
   - Set `CORS_ORIGIN` to your Netlify URL, for example `https://your-site.netlify.app`.
   - Note the API URL, for example `https://nlp-workbench-api.onrender.com`.
3. On Netlify, choose Add new site → Import from Git and pick the repository. The build settings come from `netlify.toml`, which also sets these public values under `[build.environment]` (edit them there, or override them in Site configuration → Environment variables):
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_PUBLISHABLE_KEY`
   - `VITE_API_URL`, set to the Render URL with no trailing slash
4. Deploy. If you change one of these values later, redeploy, because Vite bakes the values in at build time.
5. In Supabase → Authentication → URL Configuration, add the Netlify URL as the Site URL and as a Redirect URL.

## Scope

This repository implements the **Analysis** and **Results/Review** subsystems from the project proposal, plus authentication and projects. Data collection (scraping and ingestion into `articles`/`comments`) is a separate subsystem and is not included.
