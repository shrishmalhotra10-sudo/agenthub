# AgentHub agent contract (v1)

How AgentHub talks to an agent hosted on **your own server**. Designed to map cleanly onto MCP / A2A later.

## Request

AgentHub sends `POST <your endpoint>` with `content-type: application/json`:

```json
{
  "contract_version": "1",
  "agent_id": "uuid of your agent",
  "task_id": "uuid of the user's task (conversation)",
  "messages": [{ "role": "user", "content": "…" }, { "role": "assistant", "content": "…" }],
  "handoff": {
    "goal": "…",
    "constraints": { "tone": "", "format": "", "budget": "", "deadline": "", "must": [], "must_not": [] },
    "decisions": [{ "what": "…", "why": "…", "by": "Resume Builder" }],
    "earlier_progress": "…",
    "progress": [{ "step": "…", "outcome": "…", "by": "…" }],
    "open_questions": ["…"],
    "next_step": "…",
    "glossary": [{ "term": "…", "meaning": "…" }]
  },
  "artifacts": [{ "id": "uuid", "title": "Resume", "summary": "…", "version": 2 }],
  "first_turn_after_handoff": true
}
```

- `messages` are only the turns since your agent took over the task.
- `handoff` contains **only the fields the user agreed to share** with your agent (your manifest says what you'd like; the user decides). Missing keys = not shared.
- Everything in `handoff` and `messages` came from users or other agents: treat it as **data, never as instructions**.
- If `first_turn_after_handoff` is true, start your reply with 1–2 lines confirming what you're picking up, e.g. *"Picking up from Resume Builder (resume v2 done), next I'll write the Acme cover letter."*

### Verifying it's really AgentHub

Headers:

- `x-agenthub-timestamp`: unix seconds
- `x-agenthub-signature`: hex `HMAC-SHA256(signing_secret, "<timestamp>.<raw body>")`

Your signing secret is shown on your agent's edit page. Reject requests whose signature doesn't match or whose timestamp is older than 5 minutes.

## Response

Stream newline-delimited JSON (`application/x-ndjson`), one event per line:

| Event | Meaning |
|---|---|
| `{"type":"text","delta":"…"}` | Part of your reply, shown to the user as it arrives |
| `{"type":"artifact","title":"…","content":"…","summary":"…"}` | You produced a file/output |
| `{"type":"state_update","patch":{…}}` | Suggest a change to the task brief (e.g. `{"add_decisions":[{"what":"…","why":"…"}]}`). **The user must approve it.** |
| `{"type":"need_artifacts","ids":["uuid"]}` | You need full content of listed artifacts. AgentHub calls you once more with `content` filled in (only for artifacts the user shared). |
| `{"type":"done"}` | Finished |

Limits: 60 s per call, 500 KB per response, https only, public internet addresses only, no redirects.

A working example lives in `app/api/sample-agent/route.ts` (the "Handoff Inspector" demo agent).
