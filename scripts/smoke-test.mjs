// End-to-end smoke test for Phase 1. Run with the dev server up:
//   node scripts/smoke-test.mjs
// Creates two throwaway users (random passwords, never printed), exercises
// chat + upload + agent switching as user A, checks user B can't see A's data,
// then deletes both users and their files.
import { createClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';
import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

process.loadEnvFile('.env.local');
const BASE = process.env.SMOKE_BASE_URL ?? 'http://localhost:3000';
const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const PUB = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const SECRET = process.env.SUPABASE_SECRET_KEY;
if (!SECRET) {
  console.error('SUPABASE_SECRET_KEY is empty in .env.local — add it first.');
  process.exit(1);
}

const admin = createClient(URL_, SECRET, { auth: { persistSession: false } });
let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
};

async function makeUser(tag) {
  const email = `smoke-${tag}-${Date.now()}@example.com`;
  const password = randomBytes(18).toString('base64url');
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;

  // Sign in through @supabase/ssr so we get the same cookies a browser would.
  const jar = new Map();
  const client = createServerClient(URL_, PUB, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (list) => list.forEach(({ name, value }) => (value ? jar.set(name, value) : jar.delete(name))),
    },
  });
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw signInError;
  const cookie = [...jar].map(([n, v]) => `${n}=${encodeURIComponent(v)}`).join('; ');
  return { id: data.user.id, client, cookie };
}

async function chat(user, body) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: user.cookie },
    body: JSON.stringify(body),
  });
  if (!res.ok) return { status: res.status, text: await res.text() };
  let text = '';
  for (const line of (await res.text()).split('\n')) {
    if (!line.startsWith('data: ')) continue;
    try {
      const evt = JSON.parse(line.slice(6));
      if (evt.type === 'text-delta') text += evt.delta;
      if (evt.type === 'error') text += `[error: ${evt.errorText}]`;
    } catch {}
  }
  return { status: res.status, text };
}

async function upload(user, conversationId, name, bytes, type) {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type }), name);
  form.append('conversationId', conversationId);
  const res = await fetch(`${BASE}/api/upload`, { method: 'POST', headers: { cookie: user.cookie }, body: form });
  return { status: res.status, json: res.ok ? await res.json() : await res.text() };
}

const userMsg = (text, files = []) => ({
  id: randomUUID(),
  role: 'user',
  parts: [...files.map((f) => ({ type: 'file', url: f.url, mediaType: f.mediaType, filename: f.name })), { type: 'text', text }],
});

const created = [];
try {
  const a = await makeUser('a');
  const b = await makeUser('b');
  created.push(a, b);

  const { data: agents } = await a.client.from('agents').select('id, slug, name');
  const research = agents.find((x) => x.slug === 'research-scout');
  const writer = agents.find((x) => x.slug === 'draft-writer');
  check(agents.length >= 3 && research && writer, 'user sees the 3 seeded agents');

  const { data: configs } = await a.client.from('agent_configs').select('system_prompt');
  check((configs ?? []).length === 0, 'users cannot read agent system prompts');

  const { data: conv } = await a.client.from('conversations').insert({ user_id: a.id }).select('id').single();
  check(Boolean(conv?.id), 'user A creates a conversation');

  // Uploads: a code file, a 1x1 PNG, and a fake PNG that should be rejected.
  const code = await upload(a, conv.id, 'notes.md', new TextEncoder().encode('# Notes\nAudience: busy founders.'), 'text/markdown');
  check(code.status === 200 && code.json.readable, 'upload a markdown file (text extracted)');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const img = await upload(a, conv.id, 'pixel.png', png, 'image/png');
  check(img.status === 200, 'upload a PNG image');
  const fake = await upload(a, conv.id, 'evil.png', new TextEncoder().encode('MZ not an image'), 'image/png');
  check(fake.status === 415, 'reject a file whose contents do not match its extension');

  // Turn 1: Research Scout, with attachments.
  const t1 = await chat(a, { conversationId: conv.id, agentId: research.id, message: userMsg('Research blog ideas about remote work.', [code.json, img.json]) });
  check(t1.status === 200 && t1.text.length > 20, `turn 1 streams a reply from ${research.name}`);
  console.log('      ↳', t1.text.slice(0, 160).replace(/\n/g, ' '));

  // Turn 2: switch to Draft Writer mid-task.
  const t2 = await chat(a, { conversationId: conv.id, agentId: writer.id, message: userMsg('Now write a short intro.') });
  check(t2.status === 200 && t2.text.length > 20, `turn 2 streams a reply from ${writer.name} after switching`);
  console.log('      ↳', t2.text.slice(0, 200).replace(/\n/g, ' '));

  await new Promise((r) => setTimeout(r, 800)); // let onEnd save the reply
  const { data: saved } = await a.client
    .from('messages')
    .select('role, agent_id')
    .eq('conversation_id', conv.id)
    .order('created_at');
  check(saved?.length === 4, `conversation saved with 4 messages (got ${saved?.length})`);
  check(saved?.[1]?.agent_id === research.id && saved?.[3]?.agent_id === writer.id, 'each reply is tagged with the agent that wrote it');

  // Resending the same message id must not trigger another (free) model call.
  const firstMsg = userMsg('again');
  await chat(a, { conversationId: conv.id, agentId: writer.id, message: firstMsg });
  const dup = await chat(a, { conversationId: conv.id, agentId: writer.id, message: firstMsg });
  check(dup.status === 409, 'resending the same message is refused');

  // Users can't promote themselves or forge agent replies.
  await a.client.from('profiles').update({ is_creator: true }).eq('id', a.id);
  const { data: prof } = await admin.from('profiles').select('is_creator').eq('id', a.id).single();
  check(prof?.is_creator === false, 'users cannot make themselves creators');
  const { error: fakeReply } = await a.client.from('messages').insert({ conversation_id: conv.id, id: randomUUID(), user_id: a.id, role: 'assistant', agent_id: research.id, parts: [] });
  check(Boolean(fakeReply), 'users cannot insert fake agent replies');

  // Tampering: arbitrary URLs in file parts are rejected.
  const evil = await chat(a, {
    conversationId: conv.id,
    agentId: writer.id,
    message: { id: randomUUID(), role: 'user', parts: [{ type: 'file', url: 'http://169.254.169.254/latest', mediaType: 'text/plain' }] },
  });
  check(evil.status === 400, 'reject file parts pointing at outside URLs');

  // Isolation: user B must not see or use anything of A's.
  const { data: bConvs } = await b.client.from('conversations').select('id').eq('id', conv.id);
  check((bConvs ?? []).length === 0, "user B cannot read user A's conversation");
  const { data: bMsgs } = await b.client.from('messages').select('id').eq('conversation_id', conv.id);
  check((bMsgs ?? []).length === 0, "user B cannot read user A's messages");
  const bFile = await fetch(`${BASE}${code.json.url}`, { headers: { cookie: b.cookie } });
  check(bFile.status === 404, "user B cannot download user A's file");
  const bChat = await chat(b, { conversationId: conv.id, agentId: research.id, message: userMsg('hi') });
  check(bChat.status === 404, "user B cannot post into user A's conversation");
  const bSteal = await chat(b, {
    conversationId: (await b.client.from('conversations').insert({ user_id: b.id }).select('id').single()).data.id,
    agentId: research.id,
    message: userMsg('summarize', [code.json]),
  });
  check(bSteal.status === 400, "user B cannot attach user A's file to their own chat");
  const { error: forgeErr } = await b.client.from('messages').insert({ conversation_id: conv.id, id: 'x', user_id: b.id, role: 'user', parts: [] });
  check(Boolean(forgeErr), "user B cannot insert messages into user A's conversation");

  // ───── Phase 3: resume → job application handoff ─────
  const resume = agents.find((x) => x.slug === 'resume-builder');
  const jobs = agents.find((x) => x.slug === 'job-application-assistant');
  const inspector = agents.find((x) => x.slug === 'handoff-inspector');
  check(resume && jobs && inspector, 'resume, job-application and external demo agents exist');
  const { data: task } = await a.client.from('conversations').insert({ user_id: a.id }).select('id').single();

  const r1 = await chat(a, { conversationId: task.id, agentId: resume.id, message: userMsg('Build my resume for product manager roles. 5 years at Acme as a PM, launched 3 products.') });
  check(r1.status === 200, 'Resume Builder replies');
  await new Promise((r) => setTimeout(r, 1500)); // brief update runs after the reply

  const { data: ts1 } = await a.client.from('task_states').select('state, version').eq('conversation_id', task.id).single();
  check(Boolean(ts1?.state?.goal) && ts1.state.progress.length > 0, 'brief auto-filled with goal + progress after the first agent');

  // The user adds a decision in the side panel (simulated direct edit).
  const edited = { ...ts1.state, decisions: [{ what: 'Position as a product manager, not an engineer', why: 'all target roles are PM roles', by: 'user' }] };
  const { error: editErr } = await a.client.from('task_states').update({ state: edited, version: ts1.version + 1 }).eq('conversation_id', task.id);
  check(!editErr, 'user can edit the brief');

  // Without consent, the next agent gets nothing.
  const noConsent = await chat(a, { conversationId: task.id, agentId: jobs.id, message: userMsg('Write a cover letter.') });
  check(noConsent.status === 200 && /didn't share the task brief/i.test(noConsent.text), 'without consent, next agent receives no brief');

  // User consents (what the Hand off dialog does), then hands off again.
  await a.client.from('consents').insert({ conversation_id: task.id, user_id: a.id, agent_id: jobs.id, fields: ['goal', 'constraints', 'decisions', 'progress', 'artifacts'] });
  // Make the job agent "new" to the task again by having the resume agent reply in between.
  await chat(a, { conversationId: task.id, agentId: resume.id, message: userMsg('Thanks, looks good.') });
  await new Promise((r) => setTimeout(r, 1000));
  const handoff = await chat(a, { conversationId: task.id, agentId: jobs.id, message: userMsg('Handing off to Job Application Assistant. Next: write a cover letter for the Acme senior PM role') });
  console.log('      ↳', handoff.text.slice(0, 300).replace(/\n/g, ' '));
  check(/Picking up from Resume Builder/i.test(handoff.text), 'next agent confirms what it is picking up');
  check(/product manager/i.test(handoff.text) && /not an engineer/i.test(handoff.text), "next agent knows the goal and the user's decision without being told");

  const { data: shares } = await a.client.from('share_log').select('agent_id, fields').eq('conversation_id', task.id);
  check((shares ?? []).some((s) => s.agent_id === jobs.id), 'every share with an agent is logged');

  // External agent (creator's own server) gets only consented fields.
  await a.client.from('consents').insert({ conversation_id: task.id, user_id: a.id, agent_id: inspector.id, fields: ['goal'] });
  const ext = await chat(a, { conversationId: task.id, agentId: inspector.id, message: userMsg('What do you know?') });
  console.log('      ↳', ext.text.slice(0, 300).replace(/\n/g, ' '));
  check(/Goal: .*product manager/i.test(ext.text) && /Decisions: \(none or not shared\)/.test(ext.text), 'external agent receives only the fields the user shared');

  // Revoke → nothing shared anymore.
  await a.client.from('consents').update({ revoked_at: new Date().toISOString() }).eq('conversation_id', task.id).eq('agent_id', inspector.id);
  const ext2 = await chat(a, { conversationId: task.id, agentId: inspector.id, message: userMsg('And now?') });
  check(/Goal: \(not shared\)/.test(ext2.text), 'revoking consent stops sharing immediately');

  // Isolation for Phase 3 tables.
  const { data: bState } = await b.client.from('task_states').select('conversation_id').eq('conversation_id', task.id);
  const { data: bShares } = await b.client.from('share_log').select('id').eq('conversation_id', task.id);
  const { data: bArtifacts } = await b.client.from('artifacts').select('id').eq('conversation_id', task.id);
  check(!bState?.length && !bShares?.length && !bArtifacts?.length, "user B cannot see user A's brief, share log or artifacts");
  const { data: secretsVisible } = await a.client.from('agent_secrets').select('agent_id');
  check(!(secretsVisible ?? []).length, 'nobody can read creator API keys from the browser');

  // ───── PDF + Word uploads ─────
  const pdf = await upload(a, conv.id, 'sample.pdf', readFileSync('scripts/fixtures/sample.pdf'), 'application/pdf');
  const docx = await upload(a, conv.id, 'sample.docx', readFileSync('scripts/fixtures/sample.docx'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  const { data: extracted } = await a.client.from('files').select('name, extracted_text').in('id', [pdf.json?.id, docx.json?.id].filter(Boolean));
  const textOf = (n) => extracted?.find((f) => f.name === n)?.extracted_text ?? '';
  check(pdf.status === 200 && /AgentHub upload test/.test(textOf('sample.pdf')), 'PDF upload: text extracted');
  check(docx.status === 200 && /product manager at Acme/.test(textOf('sample.docx')), 'Word (.docx) upload: text extracted');

  // ───── The brief's demo: Research → Writer → Editor, one blog post task, three providers ─────
  const editor = agents.find((x) => x.slug === 'sharp-editor');
  const ALL = ['goal', 'constraints', 'decisions', 'progress', 'artifacts', 'open_questions', 'glossary'];
  const { data: blog } = await a.client.from('conversations').insert({ user_id: a.id }).select('id').single();
  const b1 = await chat(a, { conversationId: blog.id, agentId: research.id, message: userMsg('I want a 600-word blog post on why remote teams should write things down. Friendly tone, for startup founders.') });
  check(b1.status === 200, 'step 1: Research Scout (Gemini) researches');
  await new Promise((r) => setTimeout(r, 1200));

  await a.client.from('consents').insert({ conversation_id: blog.id, user_id: a.id, agent_id: writer.id, fields: ALL });
  const b2 = await chat(a, { conversationId: blog.id, agentId: writer.id, message: userMsg('Handing off to Draft Writer. Next: write the draft') });
  check(/Picking up from Research Scout/.test(b2.text), 'step 2: Draft Writer (Claude) picks up from Research Scout');
  await new Promise((r) => setTimeout(r, 1200));

  // The writer's decision (with real keys the writer proposes this and the user clicks Approve).
  const { data: bs } = await a.client.from('task_states').select('state, version').eq('conversation_id', blog.id).single();
  await a.client.from('task_states').update({
    state: { ...bs.state, decisions: [{ what: 'Structured as 3 numbered habits', why: 'founders skim', by: 'Draft Writer' }], constraints: { ...bs.state.constraints, tone: 'friendly' } },
    version: bs.version + 1,
  }).eq('conversation_id', blog.id);

  await a.client.from('consents').insert({ conversation_id: blog.id, user_id: a.id, agent_id: editor.id, fields: ALL });
  const b3 = await chat(a, { conversationId: blog.id, agentId: editor.id, message: userMsg('Handing off to Sharp Editor. Next: tighten the draft for clarity') });
  console.log('      ↳', b3.text.slice(0, 500).replace(/\n/g, ' '));
  check(/Picking up from Draft Writer/.test(b3.text), 'step 3: Sharp Editor (OpenAI) picks up from Draft Writer');
  check(/remote teams/i.test(b3.text), 'editor knows the original goal without being told');
  check(/3 numbered habits/.test(b3.text) && /founders skim/.test(b3.text), "editor knows the writer's decision and why");
  check(/Research Scout/.test(b3.text) && /Draft Writer/.test(b3.text), 'editor sees progress from both earlier agents');

  // ───── Creator hosting rules ─────
  const slug = `smoke-agent-${Date.now()}`;
  const { data: mine, error: createErr } = await a.client
    .from('agents')
    .insert({ slug, name: 'Smoke Agent', description: 'test', category: 'general', kind: 'nocode', provider: 'openai', model: 'gpt-6-luna', creator_id: a.id, manifest: { needs: ['goal'] }, is_published: false })
    .select('id')
    .single();
  check(!createErr && mine?.id, 'a creator can create an agent');
  const { error: cfgErr } = await a.client.from('agent_configs').insert({ agent_id: mine.id, system_prompt: 'SECRET PROMPT' });
  check(!cfgErr, 'a creator can set its instructions');
  const { data: draftSeen } = await b.client.from('agents').select('id').eq('id', mine.id);
  check(!draftSeen?.length, 'unpublished agents are hidden from other users');
  await a.client.from('agents').update({ is_published: true }).eq('id', mine.id);
  const { data: pubSeen } = await b.client.from('agents').select('id').eq('id', mine.id);
  const { data: promptSeen } = await b.client.from('agent_configs').select('system_prompt').eq('agent_id', mine.id);
  check(pubSeen?.length === 1 && !promptSeen?.length, 'published agent is listed, but its instructions stay private');
  await b.client.from('agents').update({ name: 'hijacked' }).eq('id', mine.id);
  const { data: still } = await admin.from('agents').select('name').eq('id', mine.id).single();
  check(still?.name === 'Smoke Agent', "users cannot edit someone else's agent");
  const { data: creatorChats } = await a.client.from('messages').select('id').eq('conversation_id', task.id).neq('user_id', a.id);
  check(!creatorChats?.length, "creators have no access to other users' chats");
  await admin.from('agents').delete().eq('id', mine.id);

  // ───── Robustness (as user B, who has a fresh rate-limit budget) ─────
  const { data: bConv } = await b.client.from('conversations').insert({ user_id: b.id }).select('id').single();
  const tooLong = await chat(b, { conversationId: bConv.id, agentId: research.id, message: userMsg('x'.repeat(20_001)) });
  check(tooLong.status === 400, 'messages over 20,000 characters are refused cleanly');

  // Closing the tab / refreshing mid-reply: the reply still finishes and is saved.
  const ctrl = new AbortController();
  const aborted = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: b.cookie },
    body: JSON.stringify({ conversationId: bConv.id, agentId: research.id, message: userMsg('Research remote work trends.') }),
    signal: ctrl.signal,
  });
  const reader = aborted.body.getReader();
  await reader.read(); // first chunk arrived…
  ctrl.abort(); // …then the user leaves
  await new Promise((r) => setTimeout(r, 3000));
  const { data: afterAbort } = await b.client.from('messages').select('role').eq('conversation_id', bConv.id);
  check(afterAbort?.filter((m) => m.role === 'assistant').length === 1, 'reply is still saved if the user refreshes mid-stream');

  // Provider rejects a creator's API key → user sees a clear message, not a crash.
  const { data: badAgent } = await b.client
    .from('agents')
    .insert({ slug: `smoke-badkey-${Date.now()}`, name: 'Bad Key Agent', category: 'general', kind: 'nocode', provider: 'openai', model: 'gpt-6-luna', creator_id: b.id, is_published: false })
    .select('id')
    .single();
  await b.client.from('agent_configs').insert({ agent_id: badAgent.id, system_prompt: 'test' });
  const encKey = Buffer.from(process.env.AGENTHUB_ENCRYPTION_KEY, 'base64');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encKey, iv);
  const enc = Buffer.concat([cipher.update('sk-invalid-qa-key', 'utf8'), cipher.final()]);
  await admin.from('agent_secrets').insert({ agent_id: badAgent.id, api_key_encrypted: ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join('.') });
  const badKey = await chat(b, { conversationId: bConv.id, agentId: badAgent.id, message: userMsg('hello') });
  console.log('      ↳', badKey.text.slice(0, 120));
  check(/rejected the API key/i.test(badKey.text), 'a bad provider key shows a clear error to the user');
  await admin.from('agents').delete().eq('id', badAgent.id);

  // Rapid-fire messages hit the per-minute limit with a friendly message.
  let limitedRes = null;
  for (let i = 0; i < 16 && !limitedRes; i++) {
    const r = await chat(b, { conversationId: bConv.id, agentId: research.id, message: userMsg(`ping ${i}`) });
    if (r.status === 429) limitedRes = r;
  }
  check(limitedRes && /limit/i.test(limitedRes.text), 'rapid messages are rate-limited with a clear message');

  const anon = await fetch(`${BASE}${code.json.url}`);
  check(anon.status === 401, 'signed-out visitors cannot download files');
} catch (err) {
  console.error('Smoke test crashed:', err.message ?? err);
  failures++;
} finally {
  for (const u of created) {
    const { data: objs } = await admin.storage.from('uploads').list(u.id);
    if (objs?.length) await admin.storage.from('uploads').remove(objs.map((o) => `${u.id}/${o.name}`));
    await admin.auth.admin.deleteUser(u.id);
  }
  console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed. Test users cleaned up.');
  process.exit(failures ? 1 : 0);
}
