# Épreuve C1 — Service Client Amazon

French C1 trainer, Amazon customer-service scenarios (client / vendeur / conseiller). Static frontend on GitHub Pages; Supabase for auth + server-side AI grading. Users only create an account — no API key on their side.

## Architecture
```
GitHub Pages (static)          Supabase
┌──────────────────┐   JWT    ┌──────────────────────────┐
│ index.html       │ ───────► │ Auth (email+password)    │
│ js/app.js        │          │ Edge Function /grade ────┼──► OpenRouter
│ data/questions…  │          │   OPENROUTER_API_KEY 🔒  │
│ audio/*.mp3      │          │ usage_log (rate limit)   │
└──────────────────┘          └──────────────────────────┘
```
OpenRouter key = Supabase secret, never in the repo/browser.

## Session format
| Épreuve | Type | Count | Constraint |
|---|---|---|---|
| I | MCQ comprehension | 5 | timer/question (default 90 s) |
| II | Oral reply (mic) | 4 | default 60 s max |
| III | Written mail reply | 4 | 100 words + timer (default 8 min) |

Timers adjustable on the intro screen before starting (0 = no limit). Random pick from `data/questions.json`. Final CEFR level estimated by AI.

## Setup — Supabase (once)
1. Create project → SQL editor → run `supabase/schema.sql`.
2. Auth → Providers → Email: enabled (confirm email on by default).
3. Deploy the function:
```bash
npm i -g supabase
supabase login
supabase link --project-ref <YOUR_REF>
supabase functions deploy grade
supabase secrets set OPENROUTER_API_KEY=sk-or-v1-... \
  MODEL_TEXT=anthropic/claude-sonnet-4.5 \
  MODEL_AUDIO=google/gemini-2.5-flash \
  DAILY_LIMIT=120
```
4. Fill `js/config.js` with your project URL + anon key (Settings → API). Anon key is public by design.

## Setup — GitHub Pages
```bash
git init && git add . && git commit -m "init"
git branch -M main
git remote add origin https://github.com/<you>/french-c1-trainer.git
git push -u origin main
```
Repo → Settings → Pages → main / root. Mic requires HTTPS (Pages provides it).

## Cost control
- `DAILY_LIMIT` = grading calls/user/day (a full session ≈ 6 calls: 4 oral + 1 writing batch + 1 level).
- `usage_log` table = audit per user.
- Only invited friends? Auth → disable public signups and invite by email instead.

## Adding audio / questions
- Drop mp3 in `audio/`, reference in `data/questions.json`. `transcript` = fallback + grader context.
- `comprehension`: `{id, context|audio+transcript, question, options[4], correct}`
- `oral`: `{id, audio, transcript, instruction}`
- `writing`: `{id, context, instruction}`
