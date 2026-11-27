# CampusFest Growth Center: Sponsorship

A command center for the sponsorship-growth track of the RISA Labs Growth APM assignment, with three parts:

1. **Analytics dashboard.** Funnel, targets vs actuals with projections, campaigns, pipeline and brands, all as of any date.
2. **Campaign and task management.** Tasks, owners, due dates, campaign decisions (scale, change or stop) and deal updates. Every change updates the analytics.
3. **Embedded AI copilot (Gemini).** It answers from the dashboard's own data through tool calls, diagnoses problems, recommends actions, creates tasks only after you confirm, and says when the data can't answer.

There are two datasets, switched in the sidebar:

| Mode | Data | Purpose |
|---|---|---|
| **Sample · 2025** | The assignment's `Sponsor_Dataset.xlsx` (CampusFest 2025, synthetic), rows exactly as delivered | Test case. Reviewers can change the data and ask the copilot unfamiliar questions. |
| **Live · 2026** | CampusFest 2026 Sponsorship Tracker (Google Sheet) | Runs this year's plan. Fill the sheet as numbers come in and the dashboard updates. |

## How it fits together

```
Google Sheet (2025 sample)  ─┐                       ┌─ Dashboard screens
Google Sheet (2026 tracker) ─┼─> Apps Script (read+write) ─> /api/sheet, /api/write ─> engine.js ─┤
Bundled copies (offline)    ─┘                       └─ Copilot tools ─> /api/chat ─> Gemini
```

- **`engine.js`** is the only place numbers are computed. The dashboard and every copilot tool call it, so they can't disagree.
- **The copilot loop runs in the browser.** Gemini decides which tool to call, the browser runs that tool on the engine, and the result goes back to Gemini. `/api/chat` only adds the API key, so the key never reaches the browser.
- **Writes are append-only.** A deal update in Sample mode is a new history version dated on the day you choose, so earlier snapshots don't change. The source data is built the same way.
- **No build step, no npm packages.** Plain ES modules plus three Vercel serverless functions, using Node 18+'s built-in `fetch`.

## Data rules the engine applies (from the dataset's Read me)

- Exact duplicate rows from an import retry are removed by stable ID: 3 interactions, 1 qualification version and 2 deal-history versions.
- "As of a date" means the end of that day in Asia/Kolkata. For each deal or brand, the latest history version on or before that moment is used, and history versions are never added together. Later events don't leak into earlier snapshots: an interaction dated 13 Apr is excluded from the 12 Apr snapshot.
- The target in force on the date is used: goals changed on 15 Mar 2025, from 40 to 55 qualified and from 20 to 28 confirmed.
- Brands, contacts, attempts and deals are separate populations. Beardo has 2 deals.
- A positive reply is not qualification. Confirmed value is not cash, and in-kind is not cash. Sponsor activations are associations, not proof of extra footfall.
- The data can't answer: cash collected, loss reasons, cost per deal or channel, causal uplift, or anything after 20 Apr 2025. The copilot says so instead of guessing.

## Run it locally

```bash
cp .env.example .env          # add GEMINI_API_KEY (optional for the dashboard, needed for the copilot)
node dev-server.mjs           # http://localhost:3000
```

Tests:

```bash
node tests/golden.test.mjs           # 29 checks vs answers computed independently in pandas
node tests/copilot-tools.test.mjs    # every copilot tool against the sample data
PORT=3077 node dev-server.mjs & python3 tests/e2e-copilot.py   # browser test of the copilot loop (scripted model)
```

The dashboard also has **Data & connections → Run data self-test**, which runs the same checks in the browser.

## Deploy to Vercel

1. Push this folder to a GitHub repo.
2. In Vercel: **Add New → Project → Import** the repo. The framework preset is "Other", with no build command and no output directory.
3. Under **Settings → Environment Variables**, add:

| Variable | Required | What it is |
|---|---|---|
| `GEMINI_API_KEY` | for the copilot | Free key from Google AI Studio (aistudio.google.com → Get API key) |
| `GEMINI_MODEL` | no | A Flash model id from AI Studio. Defaults to `gemini-flash-latest`, falling back to other Flash models if that id is unknown |
| `SAMPLE_SCRIPT_URL` | no | Apps Script `/exec` URL deployed on the 2025 sample sheet |
| `TRACKER_SCRIPT_URL` | no | Apps Script `/exec` URL deployed on the 2026 tracker |
| `WRITE_TOKEN` | no | Same value as the script property `WRITE_TOKEN`, if you set one |
| `SAMPLE_SHEET_ID`, `TRACKER_SHEET_ID` | no | Read-only fallback for sheets shared as "Anyone with the link can view" |

4. Redeploy. The sidebar shows whether the sheet and the copilot are connected. The same settings can also be entered in the app under **Data & connections**, where they are stored in that browser.

## The Google Sheets this deployment uses

| Sheet | Link | Vercel variable |
|---|---|---|
| CampusFest 2025 Sponsorship Data (sample) | [Open](https://docs.google.com/spreadsheets/d/1pcvCnFlZPfhaw28JlKB0poLZi0WuNczvv3nRNsNYCUM/edit) | `SAMPLE_SCRIPT_URL` (Apps Script `/exec` on this sheet) |
| CampusFest 2026 Sponsorship Tracker (live) | [Open](https://docs.google.com/spreadsheets/d/17ATh3RTrrEEJ1I1RRyKlmucen6lzKtEei39032ynZEQ/edit) | `TRACKER_SCRIPT_URL` (Apps Script `/exec` on this sheet) |

Both are created from `data/CampusFest_2025_Sponsorship_Data.xlsx` and `data/CampusFest_2026_Sponsorship_Tracker.xlsx`, so the tabs and headers match what the engine expects.

## Connect the Google Sheets (Apps Script, about 3 minutes per sheet)

1. Open the sheet → **Extensions → Apps Script** → replace the code with `apps-script/Code.gs` → Save.
2. **Deploy → New deployment → Web app**: execute as **Me**, access **Anyone**. Authorise, then copy the `/exec` URL.
3. Optional: **Project Settings → Script properties** → add `WRITE_TOKEN`.
4. Put the URL in Vercel (`SAMPLE_SCRIPT_URL` / `TRACKER_SCRIPT_URL`) or paste it in **Data & connections**.

A GET returns every tab as JSON with exact values. A POST appends or updates rows in `App_Tasks` and `App_Edits` (sample sheet), or in `Tasks`, `Deals`, `Payments`, `Creators`, `InKind` and `Signals` (tracker).

**Sheet layouts.** The 2025 sheet has one tab per source table (`event`, `targets`, `brands`, `contacts`, `campaigns`, `interactions`, `qualification`, `opportunities`, `opportunity_history`, `activations`) plus `App_Tasks` and `App_Edits`. The 2026 tracker has `Summary` (formulas), `Lines` (targets per revenue line), `Deals`, `Payments`, `Creators`, `InKind`, `Signals` and `Tasks`. Seed rows are the 24 partners from 2025 to renew and the 32 leftovers from 2025 to rescue.

## Copilot design

- **Tools (Sample mode):** `get_snapshot`, `get_campaign_funnel`, `get_breakdown`, `list_opportunities`, `list_brands`, `get_trend`, `get_targets`, `query_records` (filter, group and aggregate any table, for unfamiliar questions), `get_dashboard_insights`.
- **Tools (Live mode):** `get_live_summary`, `list_live_rows`.
- **Tools (both modes):** `list_tasks`, `propose_task` (shows a confirmation card; the model only learns "created" after a click), `calculate` (exact arithmetic).
- **System prompt:** the data's rules and limits; "call a tool for every number"; lead with the answer and the as-of date; separate evidence from assumption; refuse rather than guess.
- **Follow-up questions** reuse the chat history. Gemini's thought signatures are passed back unchanged, which Gemini 3 models require for tool calling.
- **"Data used"** under each answer shows the exact tool calls and results, so any answer can be audited.

## Known limitations

- The free Gemini tier is rate-limited. On a 429 the copilot says to retry in a minute.
- Without a connected sheet, edits and tasks are saved in the browser's localStorage. They stay on that browser only and are lost if storage is cleared.
- The public-sheet (CSV) fallback is read-only, and Google's CSV export can blank mixed-type columns. The Apps Script route is exact and is the recommended one.
- The Apps Script web app with "Anyone" access means anyone with the URL can read the sheet. Set `WRITE_TOKEN` so writes need the token.
- The pace projection on the overview is "current + recent weekly pace × weeks left". It is a simple assumption and is labelled as one on screen.

## Tools used

Plain JavaScript (ES modules), SVG charts, Node 18+ serverless functions on Vercel, Google Sheets plus Apps Script, Gemini API (free tier, function calling), Playwright for browser tests, and pandas for the independent golden answers. The code was written with Claude.
