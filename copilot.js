// Embedded AI growth analyst. Gemini plans and writes; every number comes from a tool call that runs
// in this browser against the same engine the dashboard uses. Writes (tasks) need the user's click.
import { startListening, stopListening, isListening, canListen, speak, stopSpeaking, primeAudio } from './voice.js';
import { calculate } from './engine.js';
import { getSettings, LS } from './store.js';

let C; // context from app.js
const $ = (s) => document.querySelector(s);
const MAX_ROWS = 40;
let history = []; // Gemini contents
let busy = false;

// ---------------- tool declarations ----------------
const asOf = { type: 'string', description: 'Snapshot date YYYY-MM-DD (end of day, IST). Omit to use the date selected in the dashboard.' };
const SAMPLE_TOOLS = [
  { name: 'get_snapshot', description: 'Headline numbers as of a date: brands touched, responded, meetings, qualified brands vs goal in force, deals by stage, confirmed partners vs goal, confirmed value split cash-type vs in-kind, open pipeline value, duplicates removed. Cash collected is always unknown.', parameters: { type: 'object', properties: { as_of: asOf } } },
  { name: 'get_campaign_funnel', description: 'Per-campaign funnel as of a date: attempts, brands touched/sourced, replies by outcome, meetings, opt-outs, qualified, deals, confirmed, lost, withdrawn, open, confirmed value, rates, warm/cold type. Omit campaign for all six.', parameters: { type: 'object', properties: { as_of: asOf, campaign: { type: 'string', description: 'Campaign name or ID (SC01..SC06)' } } } },
  { name: 'get_breakdown', description: 'Deals grouped by a dimension as of a date: count, confirmed, lost, withdrawn, open, confirmed value, open proposed value.', parameters: { type: 'object', properties: { as_of: asOf, dimension: { type: 'string', enum: ['industry', 'owner', 'support_type', 'channel_type', 'stage', 'campaign'] } }, required: ['dimension'] } },
  { name: 'list_opportunities', description: 'Deals (opportunities) with their stage as of a date, values, days in current stage, owner, source campaign, warm/cold, stage path. Filters combine with AND.', parameters: { type: 'object', properties: { as_of: asOf, stage: { type: 'string', enum: ['prospecting', 'contacted', 'proposal_sent', 'negotiating', 'partner_confirmed', 'lost', 'withdrawn'] }, open_only: { type: 'boolean' }, campaign: { type: 'string' }, channel_type: { type: 'string', enum: ['warm', 'cold'] }, industry: { type: 'string' }, owner: { type: 'string' }, brand: { type: 'string', description: 'brand name contains, or brand ID' }, support_type: { type: 'string', enum: ['cash', 'in_kind'] }, min_days_in_stage: { type: 'number' }, limit: { type: 'number' } } } },
  { name: 'list_brands', description: 'Brands with latest qualification status as of a date, reason, source campaign, contacts count, number of deals. Use has_opportunity=false with qualification_status=qualified for qualified brands never given a deal.', parameters: { type: 'object', properties: { as_of: asOf, qualification_status: { type: 'string', enum: ['qualified', 'engaged', 'dormant', 'unqualified', 'unreviewed', 'no_record'] }, has_opportunity: { type: 'boolean' }, channel_type: { type: 'string', enum: ['warm', 'cold'] }, industry: { type: 'string' }, source_campaign: { type: 'string' }, owner: { type: 'string' }, min_contacts: { type: 'number' }, limit: { type: 'number' } } } },
  { name: 'get_trend', description: 'A metric over time, one point per week (or day).', parameters: { type: 'object', properties: { metric: { type: 'string', enum: ['confirmed_partnerships', 'qualified_brands', 'confirmed_value_inr', 'open_pipeline_proposed_value_inr', 'opportunities', 'brands_touched', 'outreach_attempts'] }, from: { type: 'string' }, to: { type: 'string' }, interval: { type: 'string', enum: ['week', 'day'] } }, required: ['metric'] } },
  { name: 'get_targets', description: 'All target versions and the one in force on a date (goals changed on 2025-03-15).', parameters: { type: 'object', properties: { as_of: asOf } } },
  { name: 'query_records', description: 'Flexible query for questions the other tools do not cover. Filter rows of a table, then count/sum/avg/count_distinct, optionally grouped. Returns fields_available. Tables: brands, contacts, campaigns, interactions (event_type: outreach_sent, delivered, replied, meeting_booked, meeting_held, opt_out, introduction_received, web_inbound; outcome for replies: positive, neutral, not_interested, wrong_contact), qualification_latest, opportunities_latest, activations, targets.', parameters: { type: 'object', properties: { table: { type: 'string', enum: ['brands', 'contacts', 'campaigns', 'interactions', 'qualification_latest', 'opportunities_latest', 'activations', 'targets'] }, as_of: asOf, filters: { type: 'array', items: { type: 'object', properties: { field: { type: 'string' }, op: { type: 'string', enum: ['eq', 'neq', 'contains', 'in', 'gt', 'gte', 'lt', 'lte', 'is_null'] }, value: { type: 'string' } }, required: ['field'] } }, group_by: { type: 'string' }, metric: { type: 'string', enum: ['count', 'sum', 'avg', 'count_distinct'] }, field: { type: 'string', description: 'field for sum/avg/count_distinct' }, limit: { type: 'number' } }, required: ['table'] } },
  { name: 'get_dashboard_insights', description: 'The issues the dashboard flags as of the selected date (pace vs goal with projection, warm vs cold, qualified brands with no deal, idle deals, warm supply trend, confirmed vs cash).', parameters: { type: 'object', properties: {} } },
];
const LIVE_TOOLS = [
  { name: 'get_live_summary', description: '2026 tracker: by revenue line base/stretch target, deals, open pipeline, signed cash, in-kind, collected; totals; collection gap; in-kind budget offset; creator roster stats; deal stage counts.', parameters: { type: 'object', properties: {} } },
  { name: 'list_live_rows', description: 'Rows of a 2026 tracker tab, optionally filtered by one field.', parameters: { type: 'object', properties: { tab: { type: 'string', enum: ['Deals', 'Payments', 'Creators', 'InKind', 'Signals', 'Lines'] }, field: { type: 'string' }, value: { type: 'string' }, limit: { type: 'number' } }, required: ['tab'] } },
];
const COMMON_TOOLS = [
  { name: 'list_tasks', description: 'Tasks in the management tool (title, owner, due, status, linked_to, source).', parameters: { type: 'object', properties: { status: { type: 'string', enum: ['open', 'in_progress', 'blocked', 'done', 'cancelled', 'active'] } } } },
  { name: 'propose_task', description: 'Propose ONE task to add to the task tracker. The user sees a confirmation card; nothing is saved unless they click Create. Use only when the user asks for an action/task or agrees to your suggestion. Returns whether it was created.', parameters: { type: 'object', properties: { title: { type: 'string' }, owner: { type: 'string' }, due: { type: 'string', description: 'YYYY-MM-DD' }, linked_to: { type: 'string', description: 'IDs of campaigns, deals or brands' }, notes: { type: 'string', description: 'why, with the supporting numbers' } }, required: ['title', 'notes'] } },
  { name: 'calculate', description: 'Exact arithmetic. Use for every ratio, difference, average, share or projection instead of doing math in your head.', parameters: { type: 'object', properties: { expression: { type: 'string', description: 'e.g. (2240000-2000000)/24' } }, required: ['expression'] } },
];

const safe = (f) => { try { return f(); } catch { return null; } };
function systemPrompt() {
  const st = C.state;
  if (st.mode === 'sample') {
    const E = st.engine;
    return `You are the growth analyst copilot inside the CampusFest Growth Center (sponsorship track). You answer ONLY from the dashboard's data via tools.
Dataset: 2025 ACTUALS = CampusFest 2025 sponsorship data, i.e. last year's fest (the dataset provided with the assignment), covering ${E.range.start} to ${E.range.end}; fest on 12-13 Apr 2025. The dashboard's selected date is ${st.asOf}; use it as as_of unless the user names another date. Currency INR; write money as ₹ with lakh (L) or crore (Cr), e.g. ₹22.4L.
Facts about this data you must respect:
- A date means end of that day in IST. History tables give the latest version on or before the date. Never add up history rows.
- Brands, contacts, outreach attempts and deals (opportunities) are different populations. A brand can have several deals (Beardo has 2).
- A positive reply is not qualification. Confirmed value is a reported amount, NOT cash: the source has NO payment records, so cash collected is unknown. In-kind is not cash.
- Campaign association is observational: do not claim a campaign or activation caused an outcome. Sponsor activations are associations only.
- Targets changed on 2025-03-15 (qualified 40 -> 55, confirmed 20 -> 28). Compare to the target in force on the date.
- Warm = Warm Partner Introductions, Creator Network Referrals, Partner Interest Form; cold = Brand Discovery Email, Brand Leader LinkedIn, Past Conversation Revival (analyst grouping).
- Not in the data: loss reasons, payment/cash receipts, spend or time cost per deal/channel, contact-level engagement beyond the interaction log, anything after ${E.range.end}.
How to work:
1. Call tools for every number. Use calculate for any arithmetic. Never estimate a number you could look up.
2. Keep answers short: lead with the answer and its number, then 2-4 supporting points. State the as-of date. Mark what is evidence (from the data) vs assumption or judgment.
3. If the data cannot answer, say so plainly, say what is missing, and give the closest thing the data does show. Do not guess.
4. Recommendations must cite the numbers behind them. When the user wants something done, call propose_task (one task per call) with the evidence in notes; only say a task was created if the tool result says status "created".
5. Follow-up questions refer to the previous answer's subject; reuse it.
6. If a question is outside sponsorship growth for this fest, say briefly that you only cover this dashboard's data.
7. Speed: when you need several lookups, request them all in the same turn. The headline numbers below are already the get_snapshot result for ${st.asOf}; answer from them directly when they suffice.
HEADLINE (get_snapshot, as_of ${st.asOf}): ${JSON.stringify(safe(() => E.snapshot(st.asOf)))}`;
  }
  const asOf = st.liveAsOf || 'unknown';
  return `You are the growth analyst copilot inside the CampusFest Growth Center (sponsorship track), LIVE mode: the CampusFest 2026 sponsorship tracker sheet (revenue lines, deals, payments, creators, in-kind, signals, tasks). Answer ONLY from tool results.
Where the campaign stands: the tracker's latest update is ${asOf}. Treat that date as "today" when judging what is overdue or how much time is left. Plan context (from the strategy, not the sheet): a 12-week campaign from 5 Jan 2026 to the fest on 4-5 Apr 2026, so ${asOf} is about week 7. The 2026 data is an illustrative mid-campaign scenario; if asked whether it is real, say so.
Rules: cash collected comes only from the Payments tab; signed value is not cash; in-kind is tracked separately and never counted as cash (budget offset only when delivered and replacing a budget line). Base/stretch targets per revenue line come from the strategy model. Overdue = next_step_due or task due before ${asOf} on a deal or task that is not closed. Use calculate for arithmetic. Write ₹ in lakh/crore. Lead with the answer, cite numbers, mark assumptions. To create a task call propose_task; only claim it was created if the result says "created". If the user asks about 2025 history, tell them to switch the dashboard to 2025 Actuals.
Speed: when you need several lookups, request them all in the same turn. The summary below is already the get_live_summary result; answer from it directly when it suffices.
SUMMARY (get_live_summary): ${JSON.stringify(safe(() => st.liveSum))}`;
}

// ---------------- tool execution ----------------
const trim = (rows, limit) => ({ total_rows: rows.length, rows: rows.slice(0, Math.min(limit || MAX_ROWS, 100)), truncated: rows.length > Math.min(limit || MAX_ROWS, 100) });
async function runTool(name, args) {
  const st = C.state, E = st.engine, a = args.as_of || st.asOf;
  const inRange = (d) => !E || !d || (d >= E.range.start && d <= E.range.end);
  try {
    if (st.mode === 'sample' && args.as_of && !inRange(args.as_of)) return { error: `as_of ${args.as_of} is outside the data range ${E.range.start} to ${E.range.end}. The data cannot describe that date.` };
    switch (name) {
      case 'get_snapshot': return E.snapshot(a);
      case 'get_campaign_funnel': return E.campaignFunnel(a, args.campaign);
      case 'get_breakdown': return E.breakdown(a, args.dimension);
      case 'list_opportunities': { const r = E.listOpportunities(a, args); return { as_of: r.as_of, count: r.count, total_proposed_value_inr: r.total_proposed_value_inr, total_confirmed_value_inr: r.total_confirmed_value_inr, ...trim(r.rows, args.limit) }; }
      case 'list_brands': { const r = E.listBrands(a, args); return { as_of: r.as_of, count: r.count, ...trim(r.rows, args.limit) }; }
      case 'get_trend': return E.trend(args.metric, args.from, args.to || st.asOf, args.interval);
      case 'get_targets': return E.targetsAt(a);
      case 'query_records': return E.queryRecords({ ...args, as_of: a });
      case 'get_dashboard_insights': return { as_of: st.asOf, insights: C.insights().map((x) => ({ severity: x.sev, title: x.title, detail: x.detail })) };
      case 'get_live_summary': return C.liveSummary();
      case 'list_live_rows': { let rows = st.live.tracker[args.tab] || []; if (args.field) rows = rows.filter((r) => String(r[args.field] ?? '').toLowerCase().includes(String(args.value ?? '').toLowerCase())); return { tab: args.tab, ...trim(rows, args.limit) }; }
      case 'list_tasks': { let t = C.currentTasks(); if (args.status === 'active') t = t.filter((x) => !['done', 'cancelled'].includes(x.status)); else if (args.status) t = t.filter((x) => x.status === args.status); return { count: t.length, tasks: t.slice(0, 60) }; }
      case 'calculate': return calculate(args.expression);
      case 'propose_task': return await confirmTask(args);
      default: return { error: `Unknown tool ${name}` };
    }
  } catch (e) { return { error: String(e.message || e) }; }
}

function confirmTask(args) {
  return new Promise((resolve) => {
    const box = document.createElement('div');
    box.className = 'confirm';
    box.innerHTML = `<div><b>Create this task?</b></div><div style="margin-top:4px">${C.esc(args.title)}</div><div class="small muted">Owner: ${C.esc(args.owner || 'unassigned')}${args.due ? ` · due ${C.esc(args.due)}` : ''}${args.linked_to ? ` · linked: ${C.esc(args.linked_to)}` : ''}</div>${args.notes ? `<div class="small" style="margin-top:4px">${C.esc(args.notes)}</div>` : ''}<div class="actions"><button class="btn primary sm">Create task</button><button class="btn sm">Cancel</button></div>`;
    $('#cpMsgs').appendChild(box); scroll();
    const [yes, no] = box.querySelectorAll('button');
    yes.onclick = async () => { yes.disabled = no.disabled = true; const t = await C.createTask({ title: args.title, owner: args.owner || '', due: args.due || '', linked_to: args.linked_to || '', notes: args.notes || '', source: 'copilot' }); box.innerHTML = `✓ Task created: <b>${C.esc(t.title)}</b> <span class="muted small">(${t.task_id})</span>`; resolve({ status: 'created', task: t }); };
    no.onclick = () => { box.innerHTML = '<span class="muted">Task not created.</span>'; resolve({ status: 'declined_by_user' }); };
  });
}

// ---------------- Gemini call ----------------
async function callModel(contents, tools) {
  const s = getSettings(); const server = window.__GC_SERVER__;
  const body = { system: systemPrompt(), contents, tools };
  if (server && server.gemini_configured) {
    let r, j;
    for (let attempt = 0; attempt < 2; attempt++) {
      r = await fetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      j = await r.json().catch(() => ({ ok: false, error: r.status === 504 ? 'TIMEOUT' : `HTTP ${r.status}` }));
      if (j.ok || (r.status !== 504 && j.error !== 'TIMEOUT')) break; // retry a timeout once
    }
    if (!j.ok) throw new Error(j.error === 'TIMEOUT' || r.status === 504 ? 'Gemini took too long to answer. Please try again in a moment.' : j.error);
    return j;
  }
  if (s.geminiBrowserKey) {
    const model = s.geminiModel || 'gemini-3-flash-preview';
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': s.geminiBrowserKey }, body: JSON.stringify({ systemInstruction: { parts: [{ text: body.system }] }, contents, tools: [{ functionDeclarations: tools }], generationConfig: { temperature: 0.2, maxOutputTokens: 2048, thinkingConfig: { thinkingLevel: 'minimal' } } }) });
    const j = await r.json();
    if (!r.ok) throw new Error((j.error && j.error.message) || `HTTP ${r.status}`);
    const cand = (j.candidates || [])[0] || {};
    return { ok: true, model, content: cand.content || { role: 'model', parts: [] } };
  }
  throw new Error('NO_KEY');
}

// ---------------- UI ----------------
function md(text) {
  const lines = C.esc(text).split('\n'); let html = '', list = null, table = [];
  const inline = (s) => s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/(^|[^*])\*([^*]+)\*/g, '$1<i>$2</i>');
  const flushT = () => { if (!table.length) return; const rows = table.filter((r) => !/^\|?\s*:?-{2,}/.test(r)); html += '<table>' + rows.map((r, i) => '<tr>' + r.replace(/^\||\|$/g, '').split('|').map((c) => `<${i ? 'td' : 'th'}>${inline(c.trim())}</${i ? 'td' : 'th'}>`).join('') + '</tr>').join('') + '</table>'; table = []; };
  const flushL = () => { if (list) { html += `</${list}>`; list = null; } };
  for (const l of lines) {
    if (/^\s*\|.*\|\s*$/.test(l)) { flushL(); table.push(l.trim()); continue; } else flushT();
    const ul = /^\s*[-*•]\s+(.*)/.exec(l), ol = /^\s*\d+[.)]\s+(.*)/.exec(l);
    if (ul || ol) { const k = ul ? 'ul' : 'ol'; if (list !== k) { flushL(); html += `<${k}>`; list = k; } html += `<li>${inline((ul || ol)[1])}</li>`; continue; }
    flushL();
    if (/^#{1,4}\s/.test(l)) html += `<p><b>${inline(l.replace(/^#+\s/, ''))}</b></p>`; else if (l.trim()) html += `<p>${inline(l)}</p>`;
  }
  flushT(); flushL(); return html;
}
function scroll() { const m = $('#cpMsgs'); m.scrollTop = m.scrollHeight; }
function addMsg(cls, html) { const d = document.createElement('div'); d.className = `msg ${cls}`; d.innerHTML = html; $('#cpMsgs').appendChild(d); scroll(); return d; }

function suggestions() {
  const s = C.state.mode === 'sample'
    ? ['How are we tracking against the confirmed-partner goal?', 'Which campaigns should we scale, change or stop?', 'Where is the biggest bottleneck in the funnel?', 'How much cash have we collected?', 'Which qualified brands never got a proposal?', 'Why did we lose the Media deals?']
    : ['Where are we against the base target, and are we on pace?', 'Which revenue lines are furthest behind?', 'How much is signed but not yet collected, and from whom?', 'Which deals and tasks are overdue?', 'Should we keep funding the City League?', 'What should the team do this week?'];
  $('#cpSuggest').innerHTML = s.map((x) => `<button>${C.esc(x)}</button>`).join('');
  $('#cpSuggest').querySelectorAll('button').forEach((b) => (b.onclick = () => ask(b.textContent)));
}

const fmtDate = (d) => { const t = new Date(`${String(d).slice(0, 10)}T00:00:00Z`); return isNaN(t) ? String(d) : t.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }); };

function welcome() {
  $('#cpMsgs').innerHTML = '';
  const asOf = C.state.asOf || (C.state.engine && C.state.engine.range && C.state.engine.range.end);
  const when = asOf ? `, with the dashboard date set to <b>${fmtDate(asOf)}</b>` : ', using the latest date in the data';
  const mode = C.state.mode === 'sample' ? `<b>CampusFest 2025 actuals</b> (last year’s fest)${when}` : `the <b>2026 live tracker</b>${C.state.liveAsOf ? `, last updated <b>${fmtDate(C.state.liveAsOf)}</b>` : ''}`;
  addMsg('bot', `<p>I answer from ${mode}. Every number comes from the same engine as the dashboard, and I'll say so when the data can't answer. I can also create tasks once you confirm.</p>`);
  suggestions();
}

let voiceOn = false;
async function ask(text, opts = {}) {
  if (busy || !text.trim()) return;
  stopSpeaking();
  if (voiceOn || opts.voice) primeAudio(); // unlock audio during the click/keypress, before the answer arrives
  busy = true; $('#cpSuggest').innerHTML = '';
  addMsg('user', C.esc(text));
  history.push({ role: 'user', parts: [{ text: `${text}\n\n[context: dashboard mode=${C.state.mode}${C.state.mode === 'sample' ? `, selected as_of=${C.state.asOf}` : ''}]` }] });
  const tools = [...(C.state.mode === 'sample' ? SAMPLE_TOOLS : LIVE_TOOLS), ...COMMON_TOOLS];
  const typing = addMsg('typing', 'Thinking…');
  const trace = [], t0 = performance.now();
  try {
    for (let step = 0; step < 8; step++) {
      const res = await callModel(history, tools);
      const content = res.content && res.content.parts ? res.content : { role: 'model', parts: [{ text: '(no answer)' }] };
      content.role = 'model';
      history.push(content);
      const calls = content.parts.filter((p) => p.functionCall);
      const texts = content.parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('\n').trim();
      if (!calls.length) {
        typing.remove();
        const d = addMsg('bot', md(texts || '(no answer)'));
        if ((voiceOn || opts.voice) && texts) speak(texts, { onState: (on) => $('#cpVoice').classList.toggle('speaking', on) });
        const secs = ((performance.now() - t0) / 1000).toFixed(1);
        if (!trace.length) d.insertAdjacentHTML('beforeend', `<div class="trace">${secs} s · from the headline numbers</div>`);
        if (trace.length) d.insertAdjacentHTML('beforeend', `<details class="trace"><summary>${secs} s · data used: ${trace.map((t) => C.esc(t.name)).join(', ')}</summary>${trace.map((t) => `<pre>${C.esc(t.name)}(${C.esc(JSON.stringify(t.args))})\n→ ${C.esc(JSON.stringify(t.result).slice(0, 1500))}</pre>`).join('')}</details>`);
        break;
      }
      typing.textContent = `Checking data: ${calls.map((c) => c.functionCall.name).join(', ')}…`;
      const responses = await Promise.all(calls.map(async (p) => {
        const { name, args = {}, id } = p.functionCall;
        const result = await runTool(name, args);
        trace.push({ name, args, result });
        return { functionResponse: { name, ...(id ? { id } : {}), response: { result } } };
      }));
      history.push({ role: 'user', parts: responses });
      if (step === 7) { typing.remove(); addMsg('err', 'Stopped after 8 tool steps. Try a narrower question.'); }
    }
  } catch (e) {
    typing.remove();
    if (String(e.message) === 'NO_KEY') addMsg('err', 'The copilot needs a Gemini API key. Set GEMINI_API_KEY in Vercel, or paste a key under Data & connections to use it from this browser.');
    else addMsg('err', `Copilot error: ${C.esc(e.message)}`);
    history.pop();
  }
  busy = false; LS.set(`gc.chat.${C.state.mode}`, history.slice(-40));
}

export function initCopilot(ctx) {
  C = ctx;
  const open = () => { document.querySelector('.app').classList.add('cp-open'); if (!$('#cpMsgs').children.length) welcome(); $('#cpText').focus(); };
  $('#copilotBtn').onclick = () => (document.querySelector('.app').classList.contains('cp-open') ? document.querySelector('.app').classList.remove('cp-open') : open());
  $('#cpClose').onclick = () => { document.querySelector('.app').classList.remove('cp-open'); stopSpeaking(); stopListening(); };
  // voice: mic to ask, speaker toggle to hear answers (a spoken question always gets a spoken answer)
  try { voiceOn = localStorage.getItem('gc.voice') === '1'; } catch { /* no storage */ }
  const setVoiceBtn = () => { $('#cpVoice').setAttribute('aria-pressed', String(voiceOn)); $('#cpVoice').querySelector('span').textContent = voiceOn ? 'Voice on' : 'Voice off'; };
  setVoiceBtn();
  $('#cpVoice').onclick = () => { if ($('#cpVoice').classList.contains('speaking')) { stopSpeaking(); $('#cpVoice').classList.remove('speaking'); return; } voiceOn = !voiceOn; try { localStorage.setItem('gc.voice', voiceOn ? '1' : '0'); } catch { /* */ } setVoiceBtn(); if (!voiceOn) stopSpeaking(); };
  if (!canListen()) $('#cpMic').hidden = true;
  $('#cpMic').onclick = () => {
    primeAudio();
    if (isListening()) return stopListening();
    if (busy) return;
    startListening({
      onInterim: (t) => { $('#cpText').value = t; },
      onFinal: (t) => { $('#cpText').value = ''; ask(t, { voice: true }); },
      onState: (on) => { $('#cpMic').classList.toggle('on', on); $('#cpText').placeholder = on ? 'Listening… click the mic again to stop' : 'Ask, or press the mic and speak…'; },
      onError: (m) => addMsg('err', C.esc(m)),
    });
  };
  $('#cpNew').onclick = () => { history = []; stopSpeaking(); welcome(); };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.querySelector('.app').classList.remove('cp-open'); });
  $('#cpForm').onsubmit = (e) => { e.preventDefault(); const t = $('#cpText').value; $('#cpText').value = ''; ask(t); };
  $('#cpText').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#cpForm').requestSubmit(); } });
  document.querySelectorAll('.mode-switch button').forEach((b) => b.addEventListener('click', () => { history = []; setTimeout(welcome, 400); }));
  window.__GC_ASK__ = ask; // used by tests
}
export const _test = { runTool, SAMPLE_TOOLS, LIVE_TOOLS, COMMON_TOOLS, systemPrompt: () => systemPrompt(), setCtx: (c) => (C = c) };
