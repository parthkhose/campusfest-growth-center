import { createEngine, liveSummary, OPEN_STAGES, cutoffOf, istDate } from './engine.js';
import { loadSample, loadTracker, getSettings, saveSettings, appendRow, updateRow, LS, normTask } from './store.js';
import { lineChart, hbars, funnel } from './charts.js';
import { initCopilot } from './copilot.js';

// ---------- helpers ----------
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const inr = (v) => { if (v == null || isNaN(v)) return '—'; const a = Math.abs(v), s = v < 0 ? '−' : ''; if (a >= 1e7) return `${s}₹${(a / 1e7).toFixed(2)} Cr`; if (a >= 1e5) return `${s}₹${(a / 1e5).toFixed(a >= 1e6 ? 1 : 2)}L`; if (a >= 1e3) return `${s}₹${Math.round(a / 1e3)}k`; return `${s}₹${a}`; };
export const inrFull = (v) => (v == null ? '—' : '₹' + Number(v).toLocaleString('en-IN'));
const pct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`);
const $ = (s) => document.querySelector(s);
const STAGE_LABEL = { prospecting: 'Prospecting', contacted: 'Contacted', proposal_sent: 'Proposal sent', negotiating: 'Negotiating', partner_confirmed: 'Confirmed', lost: 'Lost', withdrawn: 'Withdrawn' };
const LIVE_STAGES = ['prospect', 'contacted', 'meeting', 'proposal', 'negotiating', 'signed', 'invoiced', 'partly_paid', 'paid', 'lost'];
const nowIso = () => new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 19) + '+05:30';

// ---------- state ----------
const S = {
  mode: LS.get('gc.mode', 'sample'), view: null, asOf: null,
  sample: null, engine: null, live: null, liveSum: null,
  sampleLocalEdits: LS.get('gc.sample.edits', []), sampleLocalTasks: LS.get('gc.sample.tasks', []), decisions: LS.get('gc.sample.decisions', {}),
  filters: {},
};
export const state = S;

const VIEWS = {
  sample: [['overview', 'Overview'], ['funnel', 'Funnel & campaigns'], ['pipeline', 'Pipeline'], ['brands', 'Brands'], ['tasks', 'Tasks'], ['data', 'Data & connections']],
  live: [['plan', 'Plan vs actual'], ['deals', 'Deals'], ['creators', 'Creator roster'], ['inkind', 'In-kind ledger'], ['signals', 'Bet signals'], ['tasks', 'Tasks'], ['data', 'Data & connections']],
};

function sampleOverlay() {
  const all = [...(S.sample?.remoteEdits || []), ...S.sampleLocalEdits.filter((e) => !(S.sample?.remoteEdits || []).some((r) => r.row.history_id === e.row.history_id))];
  const ov = { opportunity_history: [], qualification: [] };
  for (const e of all) if (ov[e.table]) ov[e.table].push(e.row);
  return { ov, all };
}
function rebuildEngine() { S.engine = createEngine(S.sample.raw, sampleOverlay().ov); }
export function sampleTasks() {
  const m = new Map();
  for (const t of S.sample?.remoteTasks || []) m.set(t.task_id, t);
  for (const t of S.sampleLocalTasks) m.set(t.task_id, { ...(m.get(t.task_id) || {}), ...t });
  return [...m.values()];
}
export function currentTasks() { return S.mode === 'sample' ? sampleTasks() : (S.live?.tracker.Tasks || []); }
const team = () => {
  const names = new Set(['Riya Kapoor', 'Kabir Shah', 'Nisha Rao', 'Meera Iyer']);
  if (S.engine) for (const c of S.engine.T.campaigns) names.add(c.owner_name);
  return [...names].filter(Boolean).sort();
};

// ---------- task writes (used by the UI and by the copilot after confirmation) ----------
export async function createTask(t) {
  const task = normTask({ ...t, task_id: t.task_id || `${S.mode === 'sample' ? 'T25' : 'T26'}-${Date.now().toString(36).toUpperCase()}`, created_at: nowIso(), status: t.status || 'open' });
  if (S.mode === 'sample') {
    S.sampleLocalTasks.push(task); LS.set('gc.sample.tasks', S.sampleLocalTasks);
    await appendRow('sample', 'App_Tasks', task).catch((e) => flash(`Saved in this browser; sheet write failed: ${e.message}`));
  } else {
    S.live.tracker.Tasks.push(task); persistLive();
    await appendRow('live', 'Tasks', task).catch((e) => flash(`Saved in this browser; sheet write failed: ${e.message}`));
  }
  render();
  return task;
}
async function updateTask(id, patch) {
  if (S.mode === 'sample') {
    const base = sampleTasks().find((t) => t.task_id === id); if (!base) return;
    const i = S.sampleLocalTasks.findIndex((t) => t.task_id === id);
    const nt = { ...base, ...patch };
    if (i >= 0) S.sampleLocalTasks[i] = nt; else S.sampleLocalTasks.push(nt);
    LS.set('gc.sample.tasks', S.sampleLocalTasks);
    await updateRow('sample', 'App_Tasks', 'task_id', id, patch).catch(() => {});
  } else {
    const t = S.live.tracker.Tasks.find((x) => x.task_id === id); if (!t) return;
    Object.assign(t, patch); persistLive();
    await updateRow('live', 'Tasks', 'task_id', id, patch).catch(() => {});
  }
  render();
}
function persistLive() { if (!S.live.connected) { LS.set('gc.tracker.local', S.live.tracker); S.live.localCopy = true; } S.liveSum = liveSummary(S.live.tracker); }

function flash(msg) { const b = $('#banner'); b.innerHTML = `<div class="banner">${esc(msg)}</div>`; setTimeout(() => { if (b.textContent.includes(msg)) b.innerHTML = ''; }, 6000); }

// ---------- modal ----------
function openModal(html, onSubmit) {
  $('#modalCard').innerHTML = html; $('#modal').hidden = false;
  const f = $('#modalCard form');
  $('#modalCard').querySelectorAll('[data-close]').forEach((b) => (b.onclick = () => ($('#modal').hidden = true)));
  if (f) f.onsubmit = async (e) => { e.preventDefault(); const data = Object.fromEntries(new FormData(f).entries()); const ok = await onSubmit(data); if (ok !== false) $('#modal').hidden = true; };
}
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') $('#modal').hidden = true; });

function taskModal(prefill = {}) {
  openModal(`<h2>New task</h2><form class="form">
    <label>Task<input name="title" required value="${esc(prefill.title || '')}"/></label>
    <div class="row"><label>Owner<select name="owner">${team().map((n) => `<option ${n === prefill.owner ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label>
    <label>Due<input type="date" name="due" value="${esc(prefill.due || '')}"/></label></div>
    <label>Linked to<input name="linked_to" value="${esc(prefill.linked_to || '')}" placeholder="campaign, deal or brand ID"/></label>
    <label>Notes<textarea name="notes" rows="3">${esc(prefill.notes || '')}</textarea></label>
    <div class="form-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Create task</button></div></form>`,
  async (d) => { await createTask({ ...d, source: prefill.source || 'manual' }); flash('Task created.'); });
}

// ---------- loading ----------
async function load() {
  $('#view').innerHTML = '<div class="empty">Loading data…</div>';
  if (S.mode === 'sample') {
    S.sample = await loadSample();
    rebuildEngine();
    if (!S.asOf || S.asOf < S.engine.range.start || S.asOf > S.engine.range.end) S.asOf = S.engine.range.end;
    $('#asOf').min = S.engine.range.start; $('#asOf').max = S.engine.range.end; $('#asOf').value = S.asOf;
  } else {
    S.live = await loadTracker();
    S.liveSum = liveSummary(S.live.tracker);
  }
  if ((S.mode === 'sample' ? S.sample : S.live).error) flash(`Could not read the connected sheet (${(S.mode === 'sample' ? S.sample : S.live).error}). Showing the bundled copy.`);
  render();
}

function setMode(m) { S.mode = m; LS.set('gc.mode', m); S.view = VIEWS[m][0][0]; load(); }

// ---------- render ----------
function render() {
  document.querySelectorAll('.mode-switch button').forEach((b) => b.classList.toggle('on', b.dataset.mode === S.mode));
  if (!S.view || !VIEWS[S.mode].some(([k]) => k === S.view)) S.view = VIEWS[S.mode][0][0];
  const counts = { tasks: currentTasks().filter((t) => !['done', 'cancelled'].includes(t.status)).length };
  $('#nav').innerHTML = VIEWS[S.mode].map(([k, l]) => `<button data-view="${k}" class="${k === S.view ? 'on' : ''}">${esc(l)}${counts[k] ? `<span class="count">${counts[k]}</span>` : ''}</button>`).join('');
  $('#asofWrap').style.display = S.mode === 'sample' ? '' : 'none';
  const src = S.mode === 'sample' ? S.sample : S.live;
  const cfg = window.__GC_SERVER__ || {};
  $('#sourceBadge').innerHTML = `<div><span class="dot" style="background:${src?.connected ? '#3F7CFF' : '#FBF2BA'}"></span><b>${src?.connected ? 'Sheet connected' : 'Offline copy'}</b></div><div>${esc(src?.source || '')}</div>${src?.fetched_at ? `<div>Fetched ${esc(new Date(src.fetched_at).toLocaleString('en-IN'))}</div>` : ''}<div style="margin-top:6px"><span class="dot" style="background:${cfg.gemini_configured || getSettings().geminiBrowserKey ? '#3F7CFF' : '#FBF2BA'}"></span>Copilot ${cfg.gemini_configured ? 'connected (server key)' : getSettings().geminiBrowserKey ? 'using browser key' : 'needs a Gemini key'}</div>`;
  const fn = { overview: vOverview, funnel: vFunnel, pipeline: vPipeline, brands: vBrands, tasks: vTasks, data: vData, plan: vPlan, deals: vDeals, creators: vCreators, inkind: vInKind, signals: vSignals }[S.view];
  const title = VIEWS[S.mode].find(([k]) => k === S.view)[1];
  $('#viewTitle').textContent = title;
  $('#viewSub').textContent = S.mode === 'sample' ? `Sample: CampusFest 2025 test data · as of ${S.asOf} (end of day, IST)` : 'Live: CampusFest 2026 sponsorship tracker';
  $('#view').innerHTML = fn();
  bindView();
}

// ===================== SAMPLE VIEWS =====================
function computeInsights() {
  const E = S.engine, a = S.asOf, s = E.snapshot(a);
  const out = [];
  const eventDay = (E.range.event_start || '').slice(0, 10);
  const daysLeft = Math.max(0, Math.round((cutoffOf(eventDay) - cutoffOf(a)) / 86400000));
  const back14 = istDate(cutoffOf(a) - 14 * 86400000);
  const pace = (s.confirmed_partnerships - E.snapshot(back14 < E.range.start ? E.range.start : back14).confirmed_partnerships) / 2; // per week
  if (s.confirmed_vs_goal) {
    const proj = daysLeft > 0 ? Math.round(s.confirmed_partnerships + pace * (daysLeft / 7)) : s.confirmed_partnerships;
    const short = s.confirmed_vs_goal.goal - proj;
    const over = daysLeft === 0;
    out.push({ sev: short > 0 ? 'crit' : 'good', title: over ? `Fest has started: ${s.confirmed_partnerships} of ${s.confirmed_vs_goal.goal} confirmed partners (${s.confirmed_vs_goal.met ? 'goal met' : `${-s.confirmed_vs_goal.gap} short`})` : short > 0 ? `On pace for ${proj} of ${s.confirmed_vs_goal.goal} confirmed partners` : `On pace to meet the ${s.confirmed_vs_goal.goal}-partner goal`,
      detail: over ? `Last confirmation in the data: ${E.listOpportunities(a, { stage: 'partner_confirmed' }).rows.map((o) => o.stage_since).sort().at(-1) || '—'}. Goal in force: ${s.targets_in_force.version}.` : `${s.confirmed_partnerships} confirmed now; ${pace.toFixed(1)} a week over the last 14 days; ${daysLeft} days to the fest. Projection = current + recent weekly pace × weeks left (assumption: pace holds).`, task: short > 0 && !over ? { title: `Close ${short} more partnerships before ${eventDay}`, linked_to: 'confirmed partnerships goal' } : null });
  }
  const f = E.campaignFunnel(a).campaigns;
  const agg = (t) => f.filter((c) => c.channel_type === t).reduce((m, c) => ({ opps: m.opps + c.opportunities, won: m.won + c.confirmed, att: m.att + c.attempts }), { opps: 0, won: 0, att: 0 });
  const w = agg('warm'), c = agg('cold');
  if (c.opps >= 3) out.push({ sev: c.won === 0 ? 'crit' : 'warn', title: `Cold channels: ${c.won} of ${c.opps} deals confirmed; warm: ${w.won} of ${w.opps}`, detail: `Cold = email, LinkedIn and revival (${c.att} attempts). Warm = intros, creator referrals, inbound form (${w.att} attempts). Campaign association is observational; it does not prove the channel caused the result.`, task: { title: 'Move cold-outreach hours to warm referrals and inbound follow-up', linked_to: 'SC01, SC03, SC06' } });
  const qn = E.listBrands(a, { qualification_status: 'qualified', has_opportunity: false });
  if (qn.count) out.push({ sev: 'warn', title: `${qn.count} qualified brands have no opportunity opened`, detail: `${qn.rows.filter((r) => r.channel_type === 'warm').length} came from warm channels. Examples: ${qn.rows.slice(0, 4).map((r) => r.brand_name).join(', ')}.`, task: { title: `Send proposals to ${qn.count} qualified brands with no deal`, linked_to: qn.rows.map((r) => r.brand_id).join(', ') } });
  const stalled = E.listOpportunities(a, { open_only: true, min_days_in_stage: 7 });
  if (stalled.count) out.push({ sev: 'warn', title: `${stalled.count} open deals idle 7+ days (${inr(stalled.total_proposed_value_inr)} proposed)`, detail: `Warm deals in 2025 sat 2–3 days per stage. Longest: ${stalled.rows.sort((x, y) => y.days_in_stage - x.days_in_stage).slice(0, 3).map((o) => `${o.brand_name} (${o.days_in_stage}d in ${STAGE_LABEL[o.stage]})`).join(', ')}.`, task: { title: `Unstick ${stalled.count} deals idle 7+ days`, linked_to: stalled.rows.map((o) => o.opportunity_id).join(', ') } });
  const I = E.queryRecords({ table: 'interactions', as_of: a, filters: [{ field: 'event_type', op: 'in', value: ['introduction_received', 'web_inbound'] }, { field: 'occurred_at', op: 'gte', value: back14 }] });
  const prev = E.queryRecords({ table: 'interactions', as_of: back14, filters: [{ field: 'event_type', op: 'in', value: ['introduction_received', 'web_inbound'] }, { field: 'occurred_at', op: 'gte', value: istDate(cutoffOf(back14) - 14 * 86400000) }] });
  if (prev.value > 0 && I.value < prev.value) out.push({ sev: 'warn', title: `Warm supply is falling: ${I.value} intros and inbound forms in the last 14 days vs ${prev.value} before`, detail: 'Warm channels produce almost all wins, so fewer new warm leads now means fewer confirmations in 2–3 weeks.', task: { title: 'Ask every confirmed partner and creator for one brand referral', linked_to: 'warm supply' } });
  out.push({ sev: 'info', title: `${inr(s.confirmed_value_inr)} confirmed is not cash collected`, detail: `${inr(s.confirmed_value_cash_type_inr)} cash-type, ${inr(s.confirmed_value_in_kind_inr)} in-kind. The source has no payment records, so collected cash cannot be reported.`, task: null });
  return out;
}

function kpi(label, value, foot, prog, cls = '') { return `<div class="kpi ${cls}"><div class="label">${esc(label)}</div><div class="value">${value}</div><div class="foot">${foot}</div>${prog != null ? `<div class="bar-track"><div class="bar-fill" style="width:${Math.min(100, prog * 100)}%;background:${prog >= 1 ? 'var(--good)' : 'var(--accent)'}"></div></div>` : ''}</div>`; }

function vOverview() {
  const E = S.engine, s = E.snapshot(S.asOf), tg = s.targets_in_force;
  const tr = E.trend('confirmed_partnerships', E.range.start, S.asOf, 'week');
  const trq = E.trend('qualified_brands', E.range.start, S.asOf, 'week');
  const ins = computeInsights();
  S._insights = ins;
  const f = E.campaignFunnel(S.asOf).campaigns;
  return `<div class="kpis">
    ${kpi('Qualified brands', s.qualified_brands, tg ? `goal ${tg.qualified_brands_goal} · ${s.qualified_vs_goal.met ? '<span class="pill good">✓ met</span>' : `<span class="pill crit">${s.qualified_vs_goal.gap}</span>`}` : 'no target in force', tg ? s.qualified_brands / tg.qualified_brands_goal : null)}
    ${kpi('Confirmed partners', s.confirmed_partnerships, tg ? `goal ${tg.confirmed_partnerships_goal} · ${s.confirmed_vs_goal.met ? '<span class="pill good">✓ met</span>' : `<span class="pill crit">${s.confirmed_vs_goal.gap}</span>`}` : '', tg ? s.confirmed_partnerships / tg.confirmed_partnerships_goal : null)}
    ${kpi('Confirmed value', inr(s.confirmed_value_inr), `${inr(s.confirmed_value_cash_type_inr)} cash-type · ${inr(s.confirmed_value_in_kind_inr)} in-kind`)}
    ${kpi('Open pipeline', inr(s.open_pipeline_proposed_value_inr), `${s.open_opportunities} open deals (proposed value)`)}
    ${kpi('Cash collected', 'Not in data', 'No payment records in the source', null, 'na')}
  </div>
  <div class="grid g-21">
    <div class="card"><div class="card-head"><h2>Confirmed partners vs goal</h2><span class="note">weekly, as of each date · target version: ${esc(tg?.version || '—')}</span></div>
      <div class="chart">${lineChart({ series: [{ name: 'Confirmed', color: '#0F5BFF', points: tr.series.map((p) => ({ x: p.date, y: p.value })) }, { name: 'Goal in force', color: '#666666', dash: true, step: true, points: tr.series.map((p) => ({ x: p.date, y: p.goal })) }], marker: { x: '2025-03-15', label: 'Goal raised 20 → 28' } })}</div>
      <div class="legend"><span class="line" style="--c:#0F5BFF">Confirmed partners</span><span class="dash" style="--c:#666666">Goal in force</span></div>
      <h3 style="margin-top:14px">Qualified brands vs goal</h3>
      <div class="chart">${lineChart({ height: 180, series: [{ name: 'Qualified', color: '#0F5BFF', points: trq.series.map((p) => ({ x: p.date, y: p.value })) }, { name: 'Goal in force', color: '#666666', dash: true, step: true, points: trq.series.map((p) => ({ x: p.date, y: p.goal })) }] })}</div>
    </div>
    <div class="card"><div class="card-head"><h2>Needs attention</h2><span class="note">computed from the data as of ${S.asOf}</span></div>
      ${ins.map((x, i) => `<div class="insight ${x.sev}"><div class="ic ${x.sev}">${{ crit: '!', warn: '•', good: '✓', info: 'i' }[x.sev]}</div><div class="body"><div class="title">${esc(x.title)}</div><div class="detail">${esc(x.detail)}</div>${x.task ? `<button class="btn sm" style="margin-top:6px" data-ins-task="${i}">Create task</button>` : ''}</div></div>`).join('')}
    </div>
  </div>
  <div class="card"><div class="card-head"><h2>Confirmed value by campaign</h2><span class="note">blue = warm channel, grey = cold · bar = confirmed value</span></div>
    <div class="chart">${hbars({ rows: [...f].sort((x, y) => y.confirmed_value_inr - x.confirmed_value_inr || y.attempts - x.attempts).map((c) => ({ label: c.campaign, value: c.confirmed_value_inr, color: c.channel_type === 'warm' ? '#0F5BFF' : '#CCCCCC', sub: `${inr(c.confirmed_value_inr)} · ${c.confirmed}/${c.opportunities} deals · ${c.attempts} attempts`, tip: `<b>${esc(c.campaign)}</b> (${c.channel_type})<br>${c.attempts} attempts · ${c.qualified} qualified<br>${c.confirmed} of ${c.opportunities} deals confirmed<br>${inr(c.confirmed_value_inr)} confirmed` })), fmt: inr, labelW: 210 })}</div>
  </div>`;
}

function vFunnel() {
  const E = S.engine, s = E.snapshot(S.asOf), f = E.campaignFunnel(S.asOf).campaigns;
  const stages = [
    { label: 'Brands touched', value: s.brands_touched }, { label: 'Brands responded', value: s.brands_responded, tip: 'replied, submitted the form or were introduced' },
    { label: 'Meeting held', value: s.brands_meeting_held }, { label: 'Qualified', value: s.qualified_brands, tip: 'latest qualification status = qualified' },
    { label: 'Deal opened', value: s.opportunities, tip: 'opportunities (a brand can have more than one)' }, { label: 'Proposal sent', value: s.reached_proposal }, { label: 'Confirmed', value: s.confirmed_partnerships },
  ];
  const suggest = (c) => c.channel_type === 'warm' && c.win_rate_of_opportunities >= 0.7 ? 'Scale' : c.opportunities >= 5 && c.confirmed === 0 ? 'Stop' : c.attempts >= 20 && (c.qualified_rate_of_sourced_brands ?? 0) < 0.2 ? 'Change' : 'Monitor';
  const dec = (id) => S.decisions[id] || {};
  return `<div class="card"><div class="card-head"><h2>Sponsor funnel</h2><span class="note">brands → deals; stages are different populations, so the deal stages count opportunities</span></div><div class="chart">${funnel({ stages })}</div></div>
  <div class="card"><div class="card-head"><h2>Campaigns: performance and decisions</h2><span class="note">decision is saved; "suggested" is a rule of thumb from the numbers</span></div>
  <div class="table-wrap"><table><thead><tr><th>Campaign</th><th>Type</th><th>Owner</th><th class="num">Attempts</th><th class="num">Reply rate</th><th class="num">Meetings</th><th class="num">Qualified</th><th class="num">Deals</th><th class="num">Confirmed</th><th class="num">Win rate</th><th class="num">Confirmed value</th><th class="num">Opt-outs</th><th>Suggested</th><th>Decision</th></tr></thead><tbody>
  ${f.map((c) => `<tr><td><b>${esc(c.campaign)}</b><div class="small muted">${esc(c.channel)} · ${c.campaign_id}</div></td><td><span class="pill ${c.channel_type === 'warm' ? 'blue' : ''}">${c.channel_type}</span></td><td>${esc(c.owner)}</td><td class="num">${c.attempts}</td><td class="num">${pct(c.reply_rate)}</td><td class="num">${c.meetings_held}</td><td class="num">${c.qualified}<div class="small muted">of ${c.brands_sourced} brands</div></td><td class="num">${c.opportunities}</td><td class="num">${c.confirmed}</td><td class="num">${pct(c.win_rate_of_opportunities)}</td><td class="num">${inr(c.confirmed_value_inr)}</td><td class="num">${c.opt_outs || ''}</td>
  <td><span class="pill ${{ Scale: 'good', Stop: 'crit', Change: 'warn' }[suggest(c)] || ''}">${suggest(c)}</span></td>
  <td><select data-decision="${c.campaign_id}"><option value="">—</option>${['Scale', 'Change', 'Stop', 'Monitor'].map((o) => `<option ${dec(c.campaign_id).decision === o ? 'selected' : ''}>${o}</option>`).join('')}</select>${dec(c.campaign_id).note ? `<div class="small muted">${esc(dec(c.campaign_id).note)}</div>` : ''}</td></tr>`).join('')}
  </tbody></table></div><div class="note" style="margin-top:8px">Win rate = confirmed ÷ deals opened by the campaign. Qualified counts brands whose latest qualification names the campaign as source. A positive reply alone is not qualification.</div></div>`;
}

function vPipeline() {
  const E = S.engine, fl = S.filters.pipe || {};
  const all = E.listOpportunities(S.asOf).rows;
  const rows = E.listOpportunities(S.asOf, { stage: fl.stage || undefined, channel_type: fl.type || undefined, owner: fl.owner || undefined, min_days_in_stage: fl.idle ? 7 : undefined, open_only: fl.open || undefined }).rows.sort((a, b) => (OPEN_STAGES.includes(b.stage) - OPEN_STAGES.includes(a.stage)) || b.days_in_stage - a.days_in_stage);
  const byStage = Object.keys(STAGE_LABEL).map((k) => ({ k, n: all.filter((o) => o.stage === k).length, v: all.filter((o) => o.stage === k).reduce((s, o) => s + (k === 'partner_confirmed' ? o.confirmed_value_inr : o.proposed_value_inr), 0) }));
  return `<div class="kpis">${byStage.map((b) => kpi(STAGE_LABEL[b.k], b.n, inr(b.v) + (b.k === 'partner_confirmed' ? ' confirmed' : ' proposed'))).join('')}</div>
  <div class="card"><div class="filters">
    <select data-f="pipe.stage"><option value="">All stages</option>${Object.entries(STAGE_LABEL).map(([k, l]) => `<option value="${k}" ${fl.stage === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
    <select data-f="pipe.type"><option value="">Warm and cold</option><option value="warm" ${fl.type === 'warm' ? 'selected' : ''}>Warm</option><option value="cold" ${fl.type === 'cold' ? 'selected' : ''}>Cold</option></select>
    <select data-f="pipe.owner"><option value="">All owners</option>${[...new Set(all.map((o) => o.owner_name))].sort().map((o) => `<option ${fl.owner === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>
    <label class="small"><input type="checkbox" data-f="pipe.open" ${fl.open ? 'checked' : ''}/> Open only</label>
    <label class="small"><input type="checkbox" data-f="pipe.idle" ${fl.idle ? 'checked' : ''}/> Idle 7+ days</label>
    <span class="muted small">${rows.length} deals · ${inr(rows.reduce((s, o) => s + o.proposed_value_inr, 0))} proposed</span></div>
  <div class="table-wrap"><table><thead><tr><th>Deal</th><th>Stage</th><th class="num">Days in stage</th><th class="num">Proposed</th><th class="num">Confirmed</th><th>Type</th><th>Source campaign</th><th>Owner</th><th>Path</th><th></th></tr></thead><tbody>
  ${rows.map((o) => `<tr><td><b>${esc(o.brand_name)}</b><div class="small muted">${o.opportunity_id} · ${esc(o.industry || '')} · ${o.support_type}${o.last_version_source === 'app_edit' ? ' · <span class="pill blue">edited in app</span>' : ''}</div></td>
  <td><span class="pill ${o.stage === 'partner_confirmed' ? 'good' : ['lost', 'withdrawn'].includes(o.stage) ? 'crit' : ''}">${STAGE_LABEL[o.stage]}</span></td>
  <td class="num">${OPEN_STAGES.includes(o.stage) ? `${o.days_in_stage}${o.days_in_stage >= 7 ? ' <span class="pill warn">idle</span>' : ''}` : '<span class="muted">—</span>'}</td>
  <td class="num">${inr(o.proposed_value_inr)}</td><td class="num">${o.confirmed_value_inr ? inr(o.confirmed_value_inr) : ''}</td><td>${o.channel_type}</td><td class="small">${esc(o.originating_campaign)}</td><td class="small">${esc(o.owner_name)}</td><td class="small muted">${esc(o.path)}</td>
  <td><button class="btn sm" data-edit-opp="${o.opportunity_id}">Update</button> <button class="btn sm ghost" data-task-opp="${o.opportunity_id}">Task</button></td></tr>`).join('')}
  </tbody></table></div><div class="note" style="margin-top:8px">Updating a deal appends a new history version dated on the day you choose. Earlier snapshots stay as they were.</div></div>`;
}

function vBrands() {
  const E = S.engine, fl = S.filters.brands || { preset: 'qualified_no_deal' };
  const f = {};
  if (fl.preset === 'qualified_no_deal') Object.assign(f, { qualification_status: 'qualified', has_opportunity: false });
  if (fl.status) f.qualification_status = fl.status;
  if (fl.type) f.channel_type = fl.type;
  const res = E.listBrands(S.asOf, f);
  return `<div class="card"><div class="filters">
    <select data-f="brands.preset"><option value="">All brands</option><option value="qualified_no_deal" ${fl.preset === 'qualified_no_deal' ? 'selected' : ''}>Qualified, no deal opened</option></select>
    <select data-f="brands.status"><option value="">Any qualification</option>${['qualified', 'engaged', 'dormant', 'unqualified', 'unreviewed', 'no_record'].map((k) => `<option ${fl.status === k ? 'selected' : ''}>${k}</option>`).join('')}</select>
    <select data-f="brands.type"><option value="">Warm and cold</option><option value="warm" ${fl.type === 'warm' ? 'selected' : ''}>Warm source</option><option value="cold" ${fl.type === 'cold' ? 'selected' : ''}>Cold source</option></select>
    <span class="muted small">${res.count} brands</span>${res.count ? `<button class="btn sm" data-bulk-task>Create task for these ${res.count}</button>` : ''}</div>
  <div class="table-wrap"><table><thead><tr><th>Brand</th><th>Industry</th><th>Qualification</th><th>Source</th><th class="num">Contacts</th><th class="num">Deals</th><th>Owner</th></tr></thead><tbody>
  ${res.rows.map((b) => `<tr><td><b>${esc(b.brand_name)}</b><div class="small muted">${b.brand_id}</div></td><td>${esc(b.industry)}</td><td><span class="pill ${b.qualification_status === 'qualified' ? 'good' : b.qualification_status === 'unqualified' ? 'crit' : ''}">${b.qualification_status}</span><div class="small muted">${esc(b.qualification_reason || '')}</div></td><td class="small">${esc(b.source_campaign || '')}</td><td class="num">${b.contacts}</td><td class="num">${b.opportunities || ''}</td><td class="small">${esc(b.owner)}</td></tr>`).join('')}
  </tbody></table></div></div>`;
}

function vTasks() {
  const fl = S.filters.tasks || { status: 'active' };
  let ts = currentTasks();
  if (fl.status === 'active') ts = ts.filter((t) => !['done', 'cancelled'].includes(t.status)); else if (fl.status) ts = ts.filter((t) => t.status === fl.status);
  ts.sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999'));
  const where = S.mode === 'sample' ? (S.sample.writable ? 'Saved to the sample sheet (App_Tasks)' : 'Saved in this browser; connect write-back to save to the sheet') : (S.live.writable ? 'Saved to the tracker sheet (Tasks)' : 'Saved in this browser; connect write-back to save to the sheet');
  return `<div class="card"><div class="filters"><select data-f="tasks.status"><option value="active" ${fl.status === 'active' ? 'selected' : ''}>Open and in progress</option><option value="" ${!fl.status ? 'selected' : ''}>All</option>${['open', 'in_progress', 'blocked', 'done', 'cancelled'].map((k) => `<option ${fl.status === k ? 'selected' : ''}>${k}</option>`).join('')}</select>
  <button class="btn primary sm" data-new-task>New task</button><span class="muted small">${esc(where)}</span></div>
  ${ts.length ? `<div class="table-wrap"><table><thead><tr><th>Task</th><th>Owner</th><th>Due</th><th>Status</th><th>Linked to</th><th>Source</th></tr></thead><tbody>
  ${ts.map((t) => `<tr><td><b>${esc(t.title)}</b>${t.notes ? `<div class="small muted">${esc(t.notes)}</div>` : ''}<div class="small muted">${esc(t.task_id)}</div></td><td>${esc(t.owner)}</td><td>${esc(t.due || '')}${t.due && t.due < istDate(Date.now()) && !['done', 'cancelled'].includes(t.status) && S.mode === 'live' ? ' <span class="pill crit">overdue</span>' : ''}</td>
  <td><select data-task-status="${esc(t.task_id)}">${['open', 'in_progress', 'blocked', 'done', 'cancelled'].map((k) => `<option ${t.status === k ? 'selected' : ''}>${k}</option>`).join('')}</select></td><td class="small">${esc(t.linked_to)}</td><td>${t.source === 'copilot' ? '<span class="pill blue">copilot</span>' : `<span class="pill">${esc(t.source)}</span>`}</td></tr>`).join('')}
  </tbody></table></div>` : '<div class="empty">No tasks here yet.</div>'}</div>`;
}

function vData() {
  const st = getSettings(), cfg = window.__GC_SERVER__ || {};
  const src = S.mode === 'sample' ? S.sample : S.live;
  const dd = S.mode === 'sample' ? S.engine.dedupeReport : null;
  const sheetUrl = (id) => `https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}/edit`;
  const mask = (u) => (u ? u.replace(/(macros\/s\/.{6}).+(.{6}\/exec)$/, '$1…$2') : '');
  const source = (title, desc, id, script, loaded) => `<div class="source">
      <div class="source-head"><div><div class="source-name">${title}</div><div class="small muted">${desc}</div></div>
        ${loaded ? '<span class="pill good">● Connected</span>' : script || id ? '<span class="pill warn">Not loaded yet</span>' : '<span class="pill">Not set</span>'}</div>
      <div class="source-row"><div class="k">Google Sheet</div><div class="v" title="${esc(id)}">${id ? esc(id) : '—'}</div></div>
      <div class="source-row"><div class="k">Apps Script</div><div class="v" title="${esc(script)}">${script ? esc(mask(script)) : '—'}</div></div>
      <div class="source-actions">${id ? `<a class="btn sm primary" href="${sheetUrl(id)}" target="_blank" rel="noopener">Open Google Sheet ↗</a>` : ''}${script ? `<a class="btn sm" href="${esc(script)}" target="_blank" rel="noopener">View raw JSON ↗</a>` : ''}</div>
    </div>`;
  return `<div class="grid g2"><div class="card"><div class="card-head"><h2>Connections</h2><span class="note">set on the server · read-only here</span></div>
    ${source('2025 sample data', 'CampusFest 2025 Sponsorship Data', st.sampleSheetId, st.sampleScriptUrl, S.sample && S.sample.connected)}
    ${source('Live · 2026 tracker', 'CampusFest 2026 Sponsorship Tracker', st.trackerSheetId, st.trackerScriptUrl, S.live && S.live.connected)}
    <h3 style="margin-top:18px">Copilot (Gemini)</h3>
    <div class="small">${cfg.gemini_configured ? `<span class="pill good">● Server key set</span> &nbsp;model <code>${esc(cfg.gemini_model)}</code>` : '<span class="pill warn">No server key</span> Set <code>GEMINI_API_KEY</code> in Vercel.'}
    &nbsp;${cfg.write_token_on_server ? '<span class="pill good">● Write token set</span>' : '<span class="pill">No write token</span>'}</div>
    <p class="small muted" style="margin:12px 0 0">To change a connection, update the Vercel environment variables (<code>SAMPLE_SCRIPT_URL</code>, <code>TRACKER_SCRIPT_URL</code>, <code>SAMPLE_SHEET_ID</code>, <code>TRACKER_SHEET_ID</code>) and redeploy.</p>
    <div class="form-actions"><button type="button" class="btn" id="clearLocal">Reset local edits</button></div>
  </div>
  <div class="card"><h2>Current source</h2><div class="kv"><div>Dataset</div><div>${S.mode === 'sample' ? 'Sample (CampusFest 2025 test data)' : 'Live (2026 tracker)'}</div><div>Source</div><div>${esc(src.source)}</div><div>Write-back</div><div>${src.writable ? '<span class="pill good">on</span>' : '<span class="pill warn">off (browser storage)</span>'}</div>
  ${dd ? `<div>Duplicates removed</div><div>${dd.interactions} interactions, ${dd.qualification} qualification versions, ${dd.opportunity_history} deal-history versions (same stable ID)</div><div>Edits in this browser</div><div>${S.sampleLocalEdits.length} deal updates, ${S.sampleLocalTasks.length} task changes</div>` : ''}</div>
  ${S.mode === 'sample' ? `<h3 style="margin-top:16px">Rules the numbers follow</h3><ul class="small"><li>A date means the end of that day in IST; only records on or before it count.</li><li>History tables use the latest version per deal or brand; versions are never added together.</li><li>Brands, contacts, attempts and deals are different populations.</li><li>A positive reply is not qualification. Confirmed value is not cash. Activations are associations, not proof of extra visitors.</li></ul>
  <h3 style="margin-top:12px">What this data cannot answer</h3><ul class="small"><li>Cash actually collected (no payment records)</li><li>Why deals were lost (no loss reasons)</li><li>Cost per deal or channel ROI (no spend or time data)</li><li>Causal impact of sponsor activations on footfall</li><li>Anything after 20 Apr 2025</li></ul>
  <button class="btn" id="selfTest">Run data self-test</button><div id="selfTestOut" class="small" style="margin-top:8px"></div>` : `<h3 style="margin-top:16px">How numbers flow</h3><ul class="small"><li>Deals tab → signed value by revenue line (stages signed, invoiced, partly paid, paid).</li><li>Payments tab → cash collected. Nothing else counts as cash.</li><li>InKind tab → budget offset, only when delivered and replacing a budget line, at the lower of declared value and market quote.</li><li>Lines tab → base and stretch targets from the strategy model.</li></ul>`}
  </div></div>`;
}

// ===================== LIVE VIEWS =====================
function vPlan() {
  const L = S.liveSum, t = L.totals;
  return `<div class="kpis">
    ${kpi('Signed cash', inr(t.signed_cash_inr), `base target ${inr(t.base_target_inr)} · stretch ${inr(t.stretch_target_inr)}`, t.base_target_inr ? t.signed_cash_inr / t.base_target_inr : null)}
    ${kpi('Cash collected', inr(t.collected_inr), `from the Payments tab · ${t.signed_cash_inr ? pct(t.collected_inr / t.signed_cash_inr) : '—'} of signed`)}
    ${kpi('Signed, not yet collected', inr(L.collection_gap_inr), 'chase invoices and advances')}
    ${kpi('Open pipeline', inr(t.pipeline_value_inr), `${t.deals} deals in the tracker`)}
    ${kpi('In-kind budget offset', inr(L.in_kind.budget_offset_inr), `${L.in_kind.delivered}/${L.in_kind.commitments} delivered · never counted as cash`)}
  </div>
  <div class="card"><div class="card-head"><h2>Signed cash vs base target, by revenue line</h2><span class="note">bar = signed cash · tick = base target</span></div>
  <div class="chart">${hbars({ rows: L.lines.map((l) => ({ label: l.line, value: l.signed_cash_inr, target: l.base_target_inr, color: l.bet.startsWith('Bet') ? '#0F5BFF' : '#BBD1F7', sub: `${inr(l.signed_cash_inr)} / ${inr(l.base_target_inr)}`, tip: `<b>${esc(l.line)}</b> (${esc(l.bet)})<br>Signed cash ${inr(l.signed_cash_inr)}<br>Base ${inr(l.base_target_inr)} · stretch ${inr(l.stretch_target_inr)}<br>Collected ${inr(l.collected_inr)}<br>${l.deals} deals, ${l.open} open` })), fmt: inr, labelW: 250, max: Math.max(...L.lines.map((l) => Math.max(l.base_target_inr, l.signed_cash_inr))) })}</div></div>
  <div class="card"><h2>Revenue lines</h2><div class="table-wrap tall"><table><thead><tr><th>Line</th><th>Bet</th><th class="num">Base</th><th class="num">Stretch</th><th class="num">Deals</th><th class="num">Open pipeline</th><th class="num">Signed cash</th><th class="num">In-kind</th><th class="num">Collected</th><th class="num">vs base</th></tr></thead><tbody>
  ${L.lines.map((l) => `<tr><td><b>${esc(l.line)}</b><div class="small muted">${l.line_id}</div></td><td>${esc(l.bet)}</td><td class="num">${inr(l.base_target_inr)}</td><td class="num">${inr(l.stretch_target_inr)}</td><td class="num">${l.deals}</td><td class="num">${inr(l.pipeline_value_inr)}</td><td class="num">${inr(l.signed_cash_inr)}</td><td class="num">${inr(l.signed_in_kind_inr)}</td><td class="num">${inr(l.collected_inr)}</td><td class="num">${l.pct_of_base == null ? '—' : pct(l.pct_of_base)}</td></tr>`).join('')}
  <tr><td><b>Total</b></td><td></td><td class="num"><b>${inr(t.base_target_inr)}</b></td><td class="num"><b>${inr(t.stretch_target_inr)}</b></td><td class="num"><b>${t.deals}</b></td><td class="num"><b>${inr(t.pipeline_value_inr)}</b></td><td class="num"><b>${inr(t.signed_cash_inr)}</b></td><td class="num"><b>${inr(t.signed_in_kind_inr)}</b></td><td class="num"><b>${inr(t.collected_inr)}</b></td><td></td></tr>
  </tbody></table></div></div>`;
}

function liveTable(tab, cols, rows, actions = '') {
  return `<div class="table-wrap"><table><thead><tr>${cols.map(([k, l, n]) => `<th class="${n ? 'num' : ''}">${esc(l)}</th>`).join('')}${actions ? '<th></th>' : ''}</tr></thead><tbody>
  ${rows.length ? rows.map((r) => `<tr>${cols.map(([k, l, n]) => `<td class="${n ? 'num' : ''}">${n === 'inr' ? (r[k] ? inr(Number(r[k])) : '') : esc(r[k] ?? '')}</td>`).join('')}${actions ? `<td>${actions(r)}</td>` : ''}</tr>`).join('') : `<tr><td colspan="${cols.length + 1}" class="empty">No rows yet. Add one here or in the sheet.</td></tr>`}</tbody></table></div>`;
}

function vDeals() {
  const fl = S.filters.deals || {};
  let rows = S.live.tracker.Deals;
  if (fl.line) rows = rows.filter((d) => d.revenue_line === fl.line);
  if (fl.stage) rows = rows.filter((d) => d.stage === fl.stage);
  return `<div class="card"><div class="filters"><select data-f="deals.line"><option value="">All revenue lines</option>${S.live.tracker.Lines.map((l) => `<option value="${l.line_id}" ${fl.line === l.line_id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select>
  <select data-f="deals.stage"><option value="">All stages</option>${LIVE_STAGES.map((k) => `<option ${fl.stage === k ? 'selected' : ''}>${k}</option>`).join('')}</select>
  <button class="btn primary sm" data-new-deal>New deal</button><span class="muted small">${rows.length} deals · stage counts: ${Object.entries(S.liveSum.stage_counts).map(([k, v]) => `${k} ${v}`).join(', ')}</span></div>
  ${liveTable('Deals', [['deal_id', 'ID'], ['brand', 'Brand'], ['revenue_line', 'Line'], ['stage', 'Stage'], ['support_type', 'Type'], ['owner', 'Owner'], ['proposed_value_inr', 'Proposed', 'inr'], ['signed_value_inr', 'Signed', 'inr'], ['next_step', 'Next step']], rows, (r) => `<button class="btn sm" data-edit-deal="${esc(r.deal_id)}">Update</button> <button class="btn sm ghost" data-pay-deal="${esc(r.deal_id)}">Payment</button>`)}</div>`;
}
function vCreators() {
  const c = S.liveSum.creators;
  return `<div class="kpis">${kpi('Creators on roster', c.roster, 'goal: 20+ signed by week 2', c.roster ? c.signed / 20 : 0)}${kpi('Signed or drafted', c.signed, '')}${kpi('Drafted by brands', c.drafted, 'goal: 3+ by week 4', c.drafted / 3)}${kpi('Fest net from drafts', inr(c.fest_net_inr), 'inventory fee + commission; creator fees pass through')}</div>
  <div class="card"><div class="filters"><button class="btn primary sm" data-new-row="Creators">Add creator</button><span class="muted small">Mumbai creators recruited by the team, then drafted by brands (one brand per category per creator).</span></div>
  ${liveTable('Creators', [['creator_id', 'ID'], ['name', 'Name'], ['niche', 'Niche'], ['handle', 'Handle'], ['followers', 'Followers', true], ['status', 'Status'], ['drafted_by_brand', 'Drafted by'], ['bundle_price_inr', 'Bundle', 'inr'], ['fest_net_inr', 'Fest net', 'inr'], ['registrations', 'Regs', true]], S.live.tracker.Creators)}</div>`;
}
function vInKind() {
  const k = S.liveSum.in_kind;
  return `<div class="kpis">${kpi('Commitments', k.commitments, '')}${kpi('Delivered', k.delivered, '')}${kpi('Budget offset', inr(k.budget_offset_inr), 'delivered + replaces a budget line')}</div>
  <div class="card"><div class="filters"><button class="btn primary sm" data-new-row="InKind">Add in-kind item</button><span class="muted small">${esc(k.rule)}</span></div>
  ${liveTable('InKind', [['inkind_id', 'ID'], ['partner', 'Partner'], ['item', 'Item'], ['quantity', 'Qty', true], ['declared_value_inr', 'Declared', 'inr'], ['market_quote_inr', 'Market quote', 'inr'], ['replaces_budget_line', 'Replaces budget line'], ['delivery_due', 'Due'], ['delivered', 'Delivered']], S.live.tracker.InKind)}</div>`;
}
function vSignals() {
  return `<div class="card"><div class="card-head"><h2>Pilot gates for each bet</h2><span class="note">set before launch; update the value each week</span></div>
  ${liveTable('Signals', [['bet', 'Bet'], ['metric', 'Metric'], ['value', 'Latest value'], ['week_start', 'Week of'], ['scale_if', 'Scale if'], ['stop_if', 'Stop if'], ['note', 'Note']], S.live.tracker.Signals, (r) => `<button class="btn sm" data-signal="${esc(r.metric)}">Log value</button>`)}</div>`;
}

// ---------- bindings ----------
function bindView() {
  const v = $('#view');
  v.querySelectorAll('[data-ins-task]').forEach((b) => (b.onclick = () => { const x = S._insights[+b.dataset.insTask]; taskModal({ ...x.task, notes: x.detail }); }));
  v.querySelectorAll('[data-f]').forEach((el) => (el.onchange = () => { const [g, k] = el.dataset.f.split('.'); S.filters[g] = { ...(S.filters[g] || (g === 'brands' ? { preset: 'qualified_no_deal' } : g === 'tasks' ? { status: 'active' } : {})), [k]: el.type === 'checkbox' ? el.checked : el.value }; render(); }));
  v.querySelectorAll('[data-decision]').forEach((el) => (el.onchange = () => {
    const id = el.dataset.decision, decision = el.value, name = S.engine.campById.get(id)?.campaign_name;
    const save = async (note) => {
      S.decisions[id] = { decision, note, updated_at: nowIso() }; LS.set('gc.sample.decisions', S.decisions);
      await appendRow('sample', 'App_Edits', { edit_id: `DEC-${Date.now()}`, table: 'campaign_decision', entity_id: id, effective_at: nowIso(), row_json: JSON.stringify(S.decisions[id]), edited_by: 'dashboard', created_at: nowIso() }).catch(() => {});
    };
    if (!decision) { save(''); render(); return; }
    openModal(`<h2>${esc(decision)}: ${esc(name)}</h2><form class="form"><label>Why? (saved with the decision)<textarea name="note" rows="3"></textarea></label>
      <label class="small"><input type="checkbox" name="task" ${decision === 'Monitor' ? '' : 'checked'} style="width:auto"/> Also create a task for this</label>
      <div class="form-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Save decision</button></div></form>`,
    async (d) => { await save(d.note || ''); if (d.task) { $('#modal').hidden = true; taskModal({ title: `${decision}: ${name}`, linked_to: id, notes: d.note || '' }); return false; } render(); });
    $('#modalCard').querySelector('[data-close]').onclick = () => { $('#modal').hidden = true; render(); };
  }));
  v.querySelectorAll('[data-edit-opp]').forEach((b) => (b.onclick = () => editOpp(b.dataset.editOpp)));
  v.querySelectorAll('[data-task-opp]').forEach((b) => (b.onclick = () => { const o = S.engine.listOpportunities(S.asOf, { brand: b.dataset.taskOpp }).rows[0] || S.engine.oppStates(S.asOf).find((x) => x.opportunity_id === b.dataset.taskOpp); taskModal({ title: `Follow up: ${o.brand_name} (${STAGE_LABEL[o.stage]})`, owner: o.owner_name, linked_to: o.opportunity_id }); }));
  const bulk = v.querySelector('[data-bulk-task]');
  if (bulk) bulk.onclick = () => { const fl = S.filters.brands || { preset: 'qualified_no_deal' }; const f = fl.preset === 'qualified_no_deal' ? { qualification_status: 'qualified', has_opportunity: false } : {}; if (fl.status) f.qualification_status = fl.status; if (fl.type) f.channel_type = fl.type; const r = S.engine.listBrands(S.asOf, f).rows; taskModal({ title: `Send proposals to ${r.length} brands`, linked_to: r.map((x) => x.brand_id).join(', '), notes: r.map((x) => x.brand_name).join(', ') }); };
  const nt = v.querySelector('[data-new-task]'); if (nt) nt.onclick = () => taskModal({});
  v.querySelectorAll('[data-task-status]').forEach((el) => (el.onchange = () => updateTask(el.dataset.taskStatus, { status: el.value })));
  const cl = v.querySelector('#clearLocal');
  if (cl) cl.onclick = () => openModal(`<h2>Reset local edits?</h2><p class="small">Removes deal updates, tasks and campaign decisions saved in this browser, and the local copy of the tracker. Data in the Google Sheets is not touched.</p><form class="form"><div class="form-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary danger">Reset</button></div></form>`, () => { ['gc.sample.edits', 'gc.sample.tasks', 'gc.sample.decisions', 'gc.tracker.local'].forEach(LS.del); S.sampleLocalEdits = []; S.sampleLocalTasks = []; S.decisions = {}; load(); });
  const stb = v.querySelector('#selfTest'); if (stb) stb.onclick = selfTest;
  const nd = v.querySelector('[data-new-deal]'); if (nd) nd.onclick = () => editDeal(null);
  v.querySelectorAll('[data-edit-deal]').forEach((b) => (b.onclick = () => editDeal(b.dataset.editDeal)));
  v.querySelectorAll('[data-pay-deal]').forEach((b) => (b.onclick = () => payDeal(b.dataset.payDeal)));
  v.querySelectorAll('[data-new-row]').forEach((b) => (b.onclick = () => newRow(b.dataset.newRow)));
  v.querySelectorAll('[data-signal]').forEach((b) => (b.onclick = () => logSignal(b.dataset.signal)));
}

function editOpp(id) {
  const o = S.engine.oppStates(S.asOf).find((x) => x.opportunity_id === id);
  const max = S.engine.range.end;
  openModal(`<h2>Update ${esc(o.brand_name)}</h2><p class="small muted">Adds a new history version. Snapshots before the effective date don't change.</p><form class="form">
    <div class="row"><label>Stage<select name="stage">${Object.entries(STAGE_LABEL).map(([k, l]) => `<option value="${k}" ${o.stage === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <label>Effective date<input type="date" name="date" value="${S.asOf}" min="${istDate(Date.parse(o.created_at))}" max="${max}" required/></label></div>
    <div class="row"><label>Proposed value (₹)<input type="number" name="proposed" value="${o.proposed_value_inr}" min="0"/></label>
    <label>Confirmed value (₹, if confirmed)<input type="number" name="confirmed" value="${o.confirmed_value_inr || ''}" min="0"/></label></div>
    <label>Owner<select name="owner">${team().map((n) => `<option ${n === o.owner_name ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label>
    <div class="form-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Save update</button></div></form>`,
  async (d) => {
    const confirmed = d.stage === 'partner_confirmed' ? Number(d.confirmed || d.proposed || 0) : 0;
    const row = { opportunity_name: o.opportunity_name, brand_name: o.brand_name, stage: d.stage, proposed_value_inr: Number(d.proposed || 0), confirmed_value_inr: confirmed, owner_name: d.owner, effective_at: `${d.date}T18:00:00+05:30`, history_id: `APP-${Date.now().toString(36).toUpperCase()}`, opportunity_id: o.opportunity_id, brand_id: o.brand_id, owner_id: null, source: 'app_edit' };
    S.sampleLocalEdits.push({ table: 'opportunity_history', row }); LS.set('gc.sample.edits', S.sampleLocalEdits);
    await appendRow('sample', 'App_Edits', { edit_id: row.history_id, table: 'opportunity_history', entity_id: o.opportunity_id, effective_at: row.effective_at, row_json: JSON.stringify(row), edited_by: 'dashboard', created_at: nowIso() }).catch((e) => flash(`Saved in this browser; sheet write failed: ${e.message}`));
    rebuildEngine(); render(); flash(`${o.brand_name} updated from ${d.date}. Every metric and the copilot now use it.`);
  });
}

function editDeal(id) {
  const d = id ? S.live.tracker.Deals.find((x) => x.deal_id === id) : { deal_id: `D${String(S.live.tracker.Deals.length + 1).padStart(3, '0')}`, stage: 'prospect', support_type: 'cash' };
  openModal(`<h2>${id ? 'Update deal' : 'New deal'}</h2><form class="form">
    <div class="row"><label>Brand<input name="brand" required value="${esc(d.brand || '')}"/></label><label>Revenue line<select name="revenue_line">${S.live.tracker.Lines.map((l) => `<option value="${l.line_id}" ${d.revenue_line === l.line_id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label></div>
    <div class="row"><label>Stage<select name="stage">${LIVE_STAGES.map((k) => `<option ${d.stage === k ? 'selected' : ''}>${k}</option>`).join('')}</select></label><label>Type<select name="support_type">${['cash', 'in_kind', 'mixed'].map((k) => `<option ${d.support_type === k ? 'selected' : ''}>${k}</option>`).join('')}</select></label></div>
    <div class="row"><label>Proposed (₹)<input type="number" name="proposed_value_inr" value="${esc(d.proposed_value_inr ?? '')}"/></label><label>Signed (₹)<input type="number" name="signed_value_inr" value="${esc(d.signed_value_inr ?? '')}"/></label></div>
    <div class="row"><label>Owner<select name="owner">${team().map((n) => `<option ${n === d.owner ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label><label>Next step due<input type="date" name="next_step_due" value="${esc(d.next_step_due || '')}"/></label></div>
    <label>Next step<input name="next_step" value="${esc(d.next_step || '')}"/></label>
    <div class="form-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Save</button></div></form>`,
  async (f) => {
    const patch = { ...f, proposed_value_inr: f.proposed_value_inr === '' ? '' : Number(f.proposed_value_inr), signed_value_inr: f.signed_value_inr === '' ? '' : Number(f.signed_value_inr) };
    if (['signed', 'invoiced', 'partly_paid', 'paid'].includes(f.stage) && !d.signed_date) patch.signed_date = istDate(Date.now());
    if (id) { Object.assign(d, patch); persistLive(); await updateRow('live', 'Deals', 'deal_id', id, patch).catch((e) => flash(e.message)); }
    else { const nd = { ...d, ...patch }; S.live.tracker.Deals.push(nd); persistLive(); await appendRow('live', 'Deals', nd).catch((e) => flash(e.message)); }
    render();
  });
}
function payDeal(id) {
  const d = S.live.tracker.Deals.find((x) => x.deal_id === id);
  openModal(`<h2>Log payment · ${esc(d.brand)}</h2><form class="form"><div class="row"><label>Amount received (₹)<input type="number" name="amount_inr" required min="1"/></label><label>Received on<input type="date" name="received_date" value="${istDate(Date.now())}" required/></label></div>
  <div class="row"><label>Mode<select name="mode"><option>bank transfer</option><option>UPI</option><option>cheque</option></select></label><label>Reference<input name="reference"/></label></div>
  <div class="form-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Save payment</button></div></form>`,
  async (f) => { const p = { payment_id: `P${Date.now().toString(36).toUpperCase()}`, deal_id: id, revenue_line: d.revenue_line, amount_inr: Number(f.amount_inr), received_date: f.received_date, mode: f.mode, reference: f.reference, notes: '' }; S.live.tracker.Payments.push(p); persistLive(); await appendRow('live', 'Payments', p).catch((e) => flash(e.message)); render(); });
}
function newRow(tab) {
  const cols = { Creators: ['name', 'niche', 'handle', 'followers', 'engagement_rate', 'rate_card_inr', 'status', 'drafted_by_brand', 'category_lock', 'bundle_price_inr', 'creator_fee_inr', 'fest_net_inr', 'tracked_link'], InKind: ['deal_id', 'partner', 'item', 'quantity', 'declared_value_inr', 'market_quote_inr', 'replaces_budget_line', 'delivery_due', 'delivered', 'proof'] }[tab];
  openModal(`<h2>Add to ${tab}</h2><form class="form">${cols.map((c) => `<label>${c.replace(/_/g, ' ')}<input name="${c}" ${/inr|followers|quantity|rate/.test(c) && c !== 'engagement_rate' ? 'type="number"' : ''} ${c === 'delivered' ? 'placeholder="yes or no"' : ''}${c === 'status' ? 'placeholder="shortlisted, contacted, signed, drafted"' : ''}/></label>`).join('')}<div class="form-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Add</button></div></form>`,
  async (f) => { const id = tab === 'Creators' ? 'creator_id' : 'inkind_id'; const row = { [id]: `${tab === 'Creators' ? 'C' : 'K'}${Date.now().toString(36).toUpperCase()}`, ...Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v !== '' && !isNaN(v) && /inr|followers|quantity/.test(k) ? Number(v) : v])) }; S.live.tracker[tab].push(row); persistLive(); await appendRow('live', tab, row).catch((e) => flash(e.message)); render(); });
}
function logSignal(metric) {
  const r = S.live.tracker.Signals.find((x) => x.metric === metric);
  openModal(`<h2>${esc(metric)}</h2><p class="small muted">Scale if ${esc(r.scale_if)} · stop if ${esc(r.stop_if)}</p><form class="form"><div class="row"><label>Value<input name="value" required value="${esc(r.value ?? '')}"/></label><label>Week of<input type="date" name="week_start" value="${istDate(Date.now())}"/></label></div><label>Note<input name="note" value="${esc(r.note || '')}"/></label><div class="form-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Save</button></div></form>`,
  async (f) => { Object.assign(r, f); persistLive(); await updateRow('live', 'Signals', 'metric', metric, f).catch((e) => flash(e.message)); render(); });
}

async function selfTest() {
  const out = $('#selfTestOut'); out.textContent = 'Running…';
  const raw = await (await fetch('./data/sample-2025.json')).json();
  const { createEngine: ce } = await import('./engine.js');
  const E = ce(raw); const checks = [];
  const eq = (n, g, w) => checks.push([n, JSON.stringify(g) === JSON.stringify(w), g, w]);
  [['2025-02-15', 24, 2, 170000], ['2025-03-14', 53, 17, 1505000], ['2025-03-15', 55, 17, 1505000], ['2025-03-31', 60, 23, 2090000], ['2025-04-20', 60, 24, 2240000]].forEach(([d, q, c, v]) => { const s = E.snapshot(d); eq(`snapshot ${d}`, [s.qualified_brands, s.confirmed_partnerships, s.confirmed_value_inr], [q, c, v]); });
  eq('duplicates removed', E.dedupeReport, { interactions: 3, qualification: 1, opportunity_history: 2 });
  eq('qualified with no deal', E.listBrands('2025-04-20', { qualification_status: 'qualified', has_opportunity: false }).count, 18);
  eq('attempts on 12 Apr exclude the 13 Apr event', E.snapshot('2025-04-12').outreach_attempts, 369);
  out.innerHTML = `<b>${checks.filter((c) => c[1]).length}/${checks.length} passed</b> on the original data (independent of browser edits).<br>` + checks.map((c) => `${c[1] ? '✓' : '✗'} ${esc(c[0])}: ${esc(JSON.stringify(c[2]))}`).join('<br>');
}

// ---------- tooltips ----------
document.addEventListener('mousemove', (e) => {
  const t = e.target.closest && e.target.closest('[data-tip]'); const tip = $('#tip');
  if (!t) { tip.hidden = true; return; }
  tip.innerHTML = t.getAttribute('data-tip'); tip.hidden = false;
  const x = Math.min(e.clientX + 14, window.innerWidth - 270); tip.style.left = `${x}px`; tip.style.top = `${e.clientY + 14}px`;
});

// ---------- boot ----------
document.querySelectorAll('.mode-switch button').forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
$('#nav').addEventListener('click', (e) => { const b = e.target.closest('[data-view]'); if (b) { S.view = b.dataset.view; render(); } });
$('#asOf').addEventListener('change', (e) => { const v = e.target.value; if (!v) return; S.asOf = v < S.engine.range.start ? S.engine.range.start : v > S.engine.range.end ? S.engine.range.end : v; e.target.value = S.asOf; render(); });
$('#reloadBtn').onclick = () => load();

(async function boot() {
  try { const r = await fetch('/api/config'); if (r.ok) { const c = await r.json(); window.__GC_SERVER__ = c; window.__GC_ENV__ = Object.fromEntries(Object.entries(c.env || {}).filter(([, v]) => v)); } } catch { /* static preview */ }
  S.view = VIEWS[S.mode][0][0];
  await load();
  initCopilot({ state: S, createTask, currentTasks, sampleTasks, inr, esc, render: () => render(), insights: () => computeInsights(), liveSummary: () => (S.liveSum || liveSummary(S.live.tracker)) });
})();
