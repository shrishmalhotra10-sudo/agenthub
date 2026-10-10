# AgentHub — pre-demo QA report

Date: 2026-10-10 · Scope: full app, run locally against the dev Supabase project (no production data exists).

**Result:** all 24 issues below are fixed and re-tested. Type check, lint and production build are clean; the end-to-end suite passes **51/51** checks.

## 1. App map

| Area | Pages / endpoints |
|---|---|
| Auth | `/login` (sign in / sign up / wrong-password), `/auth/callback`, sign-out (all pages), `middleware.ts` (session refresh, redirects signed-out users from `/chat` and `/creator`) |
| Marketplace | `/marketplace` (search, category filter, empty state), `/marketplace/[slug]` (agent detail, "Start a chat") |
| Chat | `/chat`, `/chat/[id]` (agent picker, streaming, markdown, uploads, Hand off dialog, Task brief panel) |
| Hosting | `/creator` (dashboard), `/creator/new`, `/creator/[id]` (edit, delete, signing secret for external agents) |
| API | `POST /api/chat`, `POST /api/upload`, `GET /api/files/[id]`, `POST /api/sample-agent` (dev-only external agent demo) |
| Server actions | `app/chat/actions.ts`, `app/chat/task-actions.ts`, `app/creator/actions.ts`, `app/login/actions.ts` |
| Database (all RLS on) | profiles, agents, agent_configs, agent_secrets, conversations, messages, files, usage_events, task_states, task_state_changes, artifacts, consents, share_log; private storage bucket `uploads` |
| External | Supabase (Auth, Postgres, Storage), OpenAI / Anthropic / Gemini via Vercel AI SDK (base URLs pinned), creator-hosted agent endpoints (signed requests) |

## 2. Issues found and fixed

| # | Severity | Where | Problem | Fix |
|---|---|---|---|---|
| 1 | **Critical** | `app/api/chat/route.ts` | If the user refreshed or closed the tab mid-reply, the agent's reply was **lost** (it was only saved when the browser finished reading the stream). | Replies are now saved on the server when generation finishes (`streamText` `onEnd`; external agents save inside the stream job). New test proves it. |
| 2 | High (demo) | `lib/agents/demo.ts` (new), `lib/taskstate/extract.ts` | Without API keys the demo was unconvincing: Resume Builder just echoed the user, no resume reached the next agent, the next agent treated "Handing off…" as the task, and its confirmation was saved as a fake "output". | Demo mode now produces a real draft resume (saved as a versioned output), proposes decisions for approval, and the Job Application Assistant writes a cover letter using **only** the shared brief and lists what it used. Clear "Demo mode" footer on every demo reply. |
| 3 | High | `app/creator/actions.ts`, `components/AgentForm.tsx` | Any validation error (e.g. duplicate web address) **wiped the whole agent form**. | Form is re-filled with what the user typed (never the API key). |
| 4 | High | `app/chat/layout.tsx`, `components/ChatView.tsx` | On phones: no navigation at all inside a chat, and the Task brief (the core feature) could not be opened below 1024 px. | Mobile top bar (chats menu, creator, sign out), back arrow, and the brief opens as a full-screen sheet. |
| 5 | High (security/privacy) | `app/api/chat/route.ts` | Provider errors were logged with the full request body — i.e. the user's conversation — into server logs. | Errors now log status, URL and a short message only. |
| 6 | Medium | `components/AppNav.tsx` | No way to sign out from marketplace / creator pages. | Sign out added to every page. |
| 7 | Medium | `components/SubmitButton.tsx` (new) | "Start a chat" / "New chat" gave no feedback for ~3 s → double clicks. | Buttons show "Starting…" and disable while working. |
| 8 | Medium | DB seed, `app/marketplace/page.tsx` | Design, Coding, Business, General categories were empty. | Seeded 4 more agents (Interview Coach, Brand Designer, Code Reviewer, Pitch Strategist); only categories with agents are shown. |
| 9 | Medium | chat + creator pages | Deleting a chat or an agent happened instantly, no confirmation. | Confirmation prompts. |
| 10 | Medium | `app/chat/actions.ts` | Deleting a chat left its uploaded files in storage (orphans). | Files are removed from storage with the chat. |
| 11 | Medium | `components/ChatView.tsx` | Messages over 20,000 characters failed with a confusing "invalid format". | Input capped with a live counter and a hint to attach long text as a file; server still rejects cleanly (tested). |
| 12 | Medium | `components/AgentForm.tsx` | Web-address `pattern` was an invalid regex in modern browsers, so client-side validation was silently skipped (console error). | Pattern fixed; verified it rejects bad and accepts good values. |
| 13 | Medium | `lib/taskstate/extract.ts` | Decision detector also matched lines like "Decisions: ✓ 2 kept", creating a bogus suggestion. | Detector anchored to real `Decision:` lines. |
| 14 | Medium (perf) | `lib/taskstate/fields.ts` (new) | The validation library was shipped to browsers just for field labels. | Chat page first load 329 kB → 261 kB; creator form 225 kB → 124 kB. |
| 15 | Low | `app/not-found.tsx` (new) | Bare unstyled 404 with no way back. | Styled 404 with link to marketplace. |
| 16 | Low | `components/HandoffDialog.tsx` | Hand-off list included the current agent; Escape didn't close it. | Current agent excluded; Escape closes. |
| 17 | Low | `components/ChatView.tsx` | Header crammed into one row; chat title truncated to "New c…". | Two-row header; full title on hover. |
| 18 | Low | `lib/taskstate/schema.ts`, `lib/chat/store.ts`, `components/TaskPanel.tsx` | Suggestions said "Updated 2 decision(s)" before approval; activity log mislabelled automatic updates as "You approved…". | Wording: "X suggests adding: 2 decisions"; activity entries corrected. |
| 19 | Low | `components/LoginForm.tsx` | Raw "Invalid login credentials"; sign-in landed on an empty chat page. | "Wrong email or password."; sign-in lands on the marketplace. |
| 20 | Low | `components/Markdown.tsx` | Markdown headings rendered huge inside chat. | Heading sizes scaled for chat. |
| 21 | Low | `app/creator/page.tsx` | Creators couldn't tell their agent had no API key (silently in demo mode). | Dashboard shows "No API key — replies in demo mode". |
| 22 | Low | `components/ChatView.tsx` | The automatic hand-off message ignored the "what should it do next" field. | Message now reads "Handing off to X. Next: …". |
| 23 | Low | `README.md` | Was the create-next-app placeholder. | Real setup/run/test instructions. |
| 24 | Low | `package.json` | No test command. | `npm test`, `npm run typecheck`. |

### Verified working (no change needed)

Sign up (instant on local), sign in, wrong password, sign out, signed-out redirects; marketplace search (incl. odd characters), filters, empty state, detail pages, 404; create / edit / publish / delete agent, duplicate address, bad endpoint URL, missing API key (demo mode), bad API key (clear "OpenAI rejected the API key" message); streaming, markdown, PDF / DOCX / image / code uploads, fake-extension files rejected, rate limit (clear message), resend protection, chat history after reload; hand-off across providers with consent, preview, revoke, audit log; user isolation (another user can't read chats, files, briefs, share logs, or post into them); creators can't read user chats or other creators' prompts/keys; no secrets in browser bundle or page HTML; no horizontal scroll at 375 px.

## 3. What I could NOT verify or fix

| Item | Why | Risk / what to do |
|---|---|---|
| Real AI answers | No OpenAI / Anthropic / Gemini keys in `.env.local`. Everything ran in demo mode. The real-model path — the AI brief updater, agents calling `read_artifact` / `propose_task_state_update`, and the "model name not recognised" error — is built but **untested with live models**. | Add keys and do one full rehearsal before the client sees it. The three demo model names (`gpt-6-luna`, `claude-sonnet-5-5`, `gemini-flash-latest`) come from the SDK's model lists; if a provider rejects one, change it in the agent's settings. |
| Real token expiry | Sessions refresh automatically in `middleware.ts`; an expired token shows "Please sign in again." I didn't wait out a real 1-hour expiry. | Low. |
| Provider timeouts | Model calls stop at 85 s, external agents at 60 s; not exercised against a slow provider. | Low. |
| Fit to context window | Brief is capped (worst case ≈ 60k chars) and history to 150k chars → roughly 55k tokens worst case, inside all three providers' limits. Not tested against a live model's limit. | Low. |
| Deployed environment | Not deployed. On Vercel, uploads above ~4.5 MB would fail (platform body limit), and instant sign-up is local-only (production uses email confirmation). | Fix before going live: direct-to-storage uploads; configure Supabase email. |
| Residual security limits | Prompt injection between agents is strongly reduced (fenced data, approval for agent-suggested decisions) but cannot be eliminated by any current system. DNS-rebinding against creator endpoints and a 5-minute signature replay window remain theoretical. | Acceptable for a demo; revisit before production. |
| Unit-test framework | Not added (would be a new dependency). The 51-check end-to-end suite covers chat, hosting and hand-off against the real database. | Add Vitest later if you want fast unit tests. |

## 4. Client demo script (≈ 6 minutes)

**Before the client joins**
1. `npm run dev` and open http://localhost:3000.
2. *(Recommended)* add `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` to `.env.local` and restart, so Resume Builder (OpenAI) and Job Application Assistant (Anthropic) give real answers. Without keys the flow still works, in labelled demo mode.
3. Create a fresh account (“New here? Create an account”) so the sidebar is empty.

**1 · The marketplace (1 min)**
- Show the agents across categories and providers. Search “resume”.
- Open **Resume Builder**: point out *Runs on OpenAI* and *“What it asks to see when you hand a task to it.”*
- Click **Start a chat with Resume Builder**.

**2 · Build the resume (1.5 min)**
- Type: *“Build my resume. I’m Priya Sharma, a product manager with 5 years at Acme where I launched 3 B2B products and grew revenue 40%. Before that I spent 2 years as a business analyst at Zeta. I’m targeting senior PM roles at fintech startups.”*
- While it streams, point at the **Task brief** panel filling in: goal, progress, and **Files & outputs → “Resume — first draft v1”**.
- In **Waiting for your approval**, show the agent’s suggested decisions (“Lead with measurable impact… because…”). Click **Approve** — *agents can’t change the brief without the user.*

**3 · Hand off to a different agent on a different model (2 min)**
- Click **Hand off →**. Pick **Job Application Assistant (Anthropic)**.
- Show the ticked fields (what this agent asked for) — untick one to show the user is in control, then re-tick.
- In *“What should it do next?”* type: *“Write a cover letter for the Senior PM role at Ramp.”*
- Scroll the **Preview** — *this is exactly what the next agent receives.* Click **Hand off**.
- The new agent opens with **“Picking up from Resume Builder (Resume — first draft is ready), next I’ll write a cover letter…”** and the letter uses the goal, both approved decisions and the resume — **nobody re-explained anything.**

**4 · Trust & control (1 min)**
- In the panel, **Who can see this task** → click **Revoke** on Job Application Assistant.
- **Activity** shows every share with every agent.
- Optional: hand off to **Handoff Inspector (external demo)** sharing only *Goal* — it replies with exactly what it received (goal only), proving creators only get what the user consents to.

**5 · Hosting (30 s)**
- **Creator → + New agent**: show no-code (instructions + model + encrypted API key) vs *My own server* (signed requests, contract in `docs/AGENT_CONTRACT.md`).

**If something goes wrong:** a red message under the chat explains it (e.g. a rejected API key). Refreshing mid-reply is safe — the reply is saved on the server.

## 5. Commands

```bash
cd ~/agenthub
npm install                # first time only
npm run dev                # http://localhost:3000
npm run typecheck && npm run lint && npm run build
npm test                   # 51 end-to-end checks; run while `npm run dev` is up
```
