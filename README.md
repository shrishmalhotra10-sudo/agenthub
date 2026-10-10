# AgentHub

A marketplace where anyone can host AI agents, users chat with any of them in one place, and a task can move from one agent to the next — across OpenAI, Anthropic and Gemini — without re-explaining anything. The **task brief** (goal, constraints, decisions, progress, files) travels with the task; the user sees it, edits it, and decides what each agent may see.

## Run it locally

Requirements: Node 20+ and a Supabase project (this repo's schema is in `supabase/migrations`, demo agents in `supabase/seed.sql`).

```bash
npm install
cp .env.example .env.local   # then fill in the values (see below)
npm run dev                  # http://localhost:3000
```

`.env.local`:

| Variable | Where it comes from | Browser-safe? |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase → Project Settings → API Keys | yes |
| `SUPABASE_SECRET_KEY` | Supabase → API Keys → Secret keys (`sb_secret_…`) | **no** |
| `AGENTHUB_ENCRYPTION_KEY`, `AGENTHUB_SIGNING_KEY` | `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` (one each) | **no** |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY` | Optional. Without them, agents answer in clearly-labelled demo mode. | **no** |

## Checks

```bash
npm run typecheck
npm run lint
npm run build
npm test        # end-to-end suite (51 checks); needs `npm run dev` running
```

## Docs

- `docs/QA_REPORT.md` — pre-demo QA findings, fixes, and the client demo script
- `docs/AGENT_CONTRACT.md` — how creators host an agent on their own server
