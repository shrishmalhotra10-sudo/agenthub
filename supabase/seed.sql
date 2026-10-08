-- Three platform demo agents on three different providers.
-- If a provider's API key isn't set in .env.local, the app falls back to the
-- built-in demo model for that agent (and says so in the reply).

with ins as (
  insert into public.agents (slug, name, description, category, kind, provider, model, manifest, is_published)
  values
    ('research-scout', 'Research Scout',
     'Finds and organizes facts, sources and angles on any topic. Hands back a tidy research brief.',
     'research', 'nocode', 'google', 'gemini-flash-latest',
     '{"needs": ["goal", "constraints", "open_questions", "glossary"]}', true),
    ('draft-writer', 'Draft Writer',
     'Turns research and notes into a clear, well-structured first draft in your voice.',
     'writing', 'nocode', 'anthropic', 'claude-sonnet-5-5',
     '{"needs": ["goal", "constraints", "decisions", "progress", "artifacts", "glossary"]}', true),
    ('sharp-editor', 'Sharp Editor',
     'Tightens, fact-checks and polishes a draft against your original goal and constraints.',
     'editing', 'nocode', 'openai', 'gpt-6-luna',
     '{"needs": ["goal", "constraints", "decisions", "progress", "artifacts", "glossary"]}', true)
  on conflict (slug) do nothing
  returning id, slug
)
insert into public.agent_configs (agent_id, system_prompt)
select id, case slug
  when 'research-scout' then
    'You are Research Scout, a research assistant. Gather the key facts, angles, audiences and open questions for the user''s topic. '
    'Output a concise research brief with headings: Key facts, Angles, Audience, Open questions. '
    'Be explicit about uncertainty; never invent statistics or sources.'
  when 'draft-writer' then
    'You are Draft Writer. Turn research and notes into a clear, engaging first draft. '
    'Match the user''s requested tone and format. Before writing, state the structure you chose in one line. '
    'After the draft, list the main writing decisions you made and why, in 2-4 bullets.'
  when 'sharp-editor' then
    'You are Sharp Editor. Improve the draft for clarity, flow and accuracy without changing decisions the user or earlier agents made on purpose. '
    'Return the edited version, then a short list of the changes you made and anything you flagged but did not change.'
end
from ins
on conflict (agent_id) do nothing;

-- Phase 2/3 demo agents: resume → job application flow, plus a sample external agent.
with ins as (
  insert into public.agents (slug, name, description, category, kind, provider, model, manifest, is_published)
  values
    ('resume-builder', 'Resume Builder',
     'Interviews you about your experience and writes a clean, targeted resume.',
     'career', 'nocode', 'openai', 'gpt-6-luna',
     '{"needs": ["goal", "constraints", "decisions", "progress", "artifacts", "glossary"]}', true),
    ('job-application-assistant', 'Job Application Assistant',
     'Takes your resume and target roles, then writes tailored cover letters and application answers.',
     'career', 'nocode', 'anthropic', 'claude-sonnet-5-5',
     '{"needs": ["goal", "constraints", "decisions", "progress", "artifacts", "open_questions", "glossary"]}', true),
    ('handoff-inspector', 'Handoff Inspector (external demo)',
     'A sample externally hosted agent. It replies with exactly what context it received, so you can see what gets shared.',
     'developer', 'external', null, null,
     '{"needs": ["goal", "constraints", "decisions", "progress", "artifacts"]}', true)
  on conflict (slug) do nothing
  returning id, slug
)
insert into public.agent_configs (agent_id, system_prompt, endpoint_url)
select id,
  case slug
    when 'resume-builder' then
      'You are Resume Builder. Ask only for missing essentials (target role, experience, skills, achievements), then write a concise, ATS-friendly resume in Markdown. '
      'Quantify achievements where the user gave numbers; never invent employers, dates or metrics. After the resume, list the key choices you made (e.g. format, which roles to emphasise) and why.'
    when 'job-application-assistant' then
      'You are Job Application Assistant. Using the user''s resume and goals, write tailored cover letters and answers to application questions for specific roles. '
      'Keep every fact consistent with the resume; do not undo earlier decisions about positioning or tone unless the user asks. Ask for the job description if you do not have it.'
    else ''
  end,
  case slug when 'handoff-inspector' then 'http://localhost:3000/api/sample-agent' else null end
from ins
on conflict (agent_id) do nothing;
