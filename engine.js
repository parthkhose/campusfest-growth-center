// Growth Center metrics engine.
// One engine feeds every dashboard screen AND every copilot tool, so the numbers can never disagree.
// Works in the browser and in Node (tests). No dependencies.
//
// Source rules applied (from the dataset's Read me):
//  - De-duplicate exact import retries by stable ID (interaction_id, history_id).
//  - "As of" a date = end of that day in Asia/Kolkata (23:59:59.999 +05:30).
//  - History tables are full-state versions: take the latest version <= cutoff; never sum versions.
//  - A later response/outcome must not leak into an earlier snapshot.
//  - A positive reply is not qualification; confirmed value is not cash; activations are associations, not uplift.

export const WARM_CAMPAIGNS = new Set(['SC02', 'SC04', 'SC05']); // intros, inbound form, creator referrals
export const OPEN_STAGES = ['prospecting', 'contacted', 'proposal_sent', 'negotiating'];
export const STAGES = ['prospecting', 'contacted', 'proposal_sent', 'negotiating', 'partner_confirmed', 'lost', 'withdrawn'];
const DAY = 86400000;

export const ts = (s) => (s == null || s === '' ? NaN : Date.parse(s));
export const cutoffOf = (asOf) => Date.parse(`${asOf}T23:59:59.999+05:30`);
export const istDate = (ms) => new Date(ms + 5.5 * 3600000).toISOString().slice(0, 10);
const uniq = (arr) => [...new Set(arr)];
const sum = (arr, f) => arr.reduce((s, r) => s + (Number(f(r)) || 0), 0);

function dedupe(rows, idField) {
  const seen = new Map();
  let dupes = 0;
  for (const r of rows) {
    const id = r[idField];
    if (id == null) { seen.set(Symbol(), r); continue; }
    if (seen.has(id)) { dupes++; continue; }
    seen.set(id, r);
  }
  return { rows: [...seen.values()], dupes };
}

function latestPerKey(rows, key, cut, timeField = 'effective_at') {
  const out = new Map();
  for (const r of rows) {
    const t = ts(r[timeField]);
    if (!(t <= cut)) continue;
    const cur = out.get(r[key]);
    if (!cur || t > ts(cur[timeField]) || (t === ts(cur[timeField]) && String(r.history_id) > String(cur.history_id))) out.set(r[key], r);
  }
  return out;
}

export function createEngine(raw, overlay = {}) {
  // Overlay = rows written by the app (stage edits, qualification edits). Append-only: they never overwrite source rows.
  const merged = {};
  for (const k of Object.keys(raw)) merged[k] = Array.isArray(raw[k]) ? [...raw[k], ...(overlay[k] || [])] : raw[k];
  for (const k of Object.keys(overlay)) if (!merged[k]) merged[k] = [...overlay[k]];

  const dI = dedupe(merged.interactions || [], 'interaction_id');
  const dQ = dedupe(merged.qualification || [], 'history_id');
  const dO = dedupe(merged.opportunity_history || [], 'history_id');
  const T = {
    event: (merged.event || [])[0] || {},
    targets: [...(merged.targets || [])].sort((a, b) => ts(a.effective_at) - ts(b.effective_at)),
    brands: merged.brands || [],
    contacts: merged.contacts || [],
    campaigns: merged.campaigns || [],
    interactions: dI.rows,
    qualification: dQ.rows,
    opportunities: merged.opportunities || [],
    opportunity_history: dO.rows,
    activations: merged.activations || [],
  };
  const dedupeReport = { interactions: dI.dupes, qualification: dQ.dupes, opportunity_history: dO.dupes };
  const brandById = new Map(T.brands.map((b) => [b.brand_id, b]));
  const campById = new Map(T.campaigns.map((c) => [c.sponsor_campaign_id, c]));
  const oppById = new Map(T.opportunities.map((o) => [o.opportunity_id, o]));
  const contactsByBrand = new Map();
  for (const c of T.contacts) contactsByBrand.set(c.brand_id, (contactsByBrand.get(c.brand_id) || 0) + 1);

  const range = {
    start: (T.event.history_start || '').slice(0, 10),
    end: (T.event.history_end || '').slice(0, 10),
    event_start: T.event.event_starts_at,
    event_end: T.event.event_ends_at,
  };
  const normAsOf = (asOf) => asOf || range.end;

  function targetsAt(asOf) {
    const cut = cutoffOf(normAsOf(asOf));
    const inForce = T.targets.filter((t) => ts(t.effective_at) <= cut).pop() || null;
    return { in_force: inForce, all_versions: T.targets };
  }

  function oppStates(asOf) {
    const cut = cutoffOf(normAsOf(asOf));
    const latest = latestPerKey(T.opportunity_history, 'opportunity_id', cut);
    const out = [];
    for (const o of T.opportunities) {
      if (!(ts(o.created_at) <= cut)) continue;
      const hist = T.opportunity_history.filter((h) => h.opportunity_id === o.opportunity_id && ts(h.effective_at) <= cut).sort((a, b) => ts(a.effective_at) - ts(b.effective_at));
      const cur = latest.get(o.opportunity_id);
      const stage = cur ? cur.stage : 'prospecting';
      // stage_since = start of the current run of this stage
      let since = cur ? ts(cur.effective_at) : ts(o.created_at);
      for (let i = hist.length - 1; i >= 0; i--) { if (hist[i].stage === stage) since = ts(hist[i].effective_at); else break; }
      const b = brandById.get(o.brand_id) || {};
      const c = campById.get(o.sponsor_campaign_id) || {};
      out.push({
        opportunity_id: o.opportunity_id, opportunity_name: o.opportunity_name, brand_id: o.brand_id, brand_name: o.brand_name,
        industry: b.industry || null, originating_campaign: o.originating_campaign_name, sponsor_campaign_id: o.sponsor_campaign_id,
        channel_type: WARM_CAMPAIGNS.has(o.sponsor_campaign_id) ? 'warm' : 'cold', channel: c.channel || null,
        support_type: o.support_type, stage, proposed_value_inr: cur ? cur.proposed_value_inr || 0 : 0,
        confirmed_value_inr: cur ? cur.confirmed_value_inr || 0 : 0, owner_name: cur ? cur.owner_name : null,
        created_at: o.created_at, stage_since: since ? istDate(since) : null,
        days_in_stage: since ? Math.floor((cut - since) / DAY) : null,
        ever_proposal: hist.some((h) => h.stage === 'proposal_sent'), ever_confirmed: hist.some((h) => h.stage === 'partner_confirmed'),
        path: uniq(hist.map((h) => h.stage)).join(' > '), primary_contact_id: o.primary_contact_id, primary_contact_name: o.primary_contact_name,
        last_version_source: cur && cur.source === 'app_edit' ? 'app_edit' : 'source',
      });
    }
    return out;
  }

  function qualStates(asOf) {
    const cut = cutoffOf(normAsOf(asOf));
    return latestPerKey(T.qualification, 'brand_id', cut);
  }

  function interactionsUpTo(asOf) {
    const cut = cutoffOf(normAsOf(asOf));
    return T.interactions.filter((i) => ts(i.occurred_at) <= cut);
  }

  function snapshot(asOf) {
    asOf = normAsOf(asOf);
    const cut = cutoffOf(asOf);
    const I = interactionsUpTo(asOf);
    const q = qualStates(asOf);
    const opps = oppStates(asOf);
    const tg = targetsAt(asOf).in_force;
    const qualCounts = {};
    for (const r of q.values()) qualCounts[r.qualification_status] = (qualCounts[r.qualification_status] || 0) + 1;
    const stageCounts = Object.fromEntries(STAGES.map((s) => [s, 0]));
    for (const o of opps) stageCounts[o.stage] = (stageCounts[o.stage] || 0) + 1;
    const conf = opps.filter((o) => o.stage === 'partner_confirmed');
    const open = opps.filter((o) => OPEN_STAGES.includes(o.stage));
    const brandsWith = (pred) => uniq(I.filter(pred).map((i) => i.brand_id)).length;
    const qualified = qualCounts.qualified || 0;
    const confirmed = conf.length;
    return {
      as_of: asOf,
      as_of_rule: 'end of day, Asia/Kolkata; latest history version on or before it',
      data_range: range,
      targets_in_force: tg ? { version: tg.target_version, effective_at: tg.effective_at, qualified_brands_goal: tg.qualified_brands_goal, confirmed_partnerships_goal: tg.confirmed_partnerships_goal } : null,
      brands_in_research: T.brands.filter((b) => ts(b.created_at) <= cut).length,
      brands_touched: uniq(I.map((i) => i.brand_id)).length,
      contacts_touched: uniq(I.map((i) => i.contact_id)).length,
      outreach_attempts: uniq(I.map((i) => i.attempt_id)).length,
      brands_responded: brandsWith((i) => ['replied', 'web_inbound', 'introduction_received'].includes(i.event_type)),
      brands_positive_reply: brandsWith((i) => i.event_type === 'replied' && i.outcome === 'positive'),
      brands_meeting_held: brandsWith((i) => i.event_type === 'meeting_held'),
      opt_outs: I.filter((i) => i.event_type === 'opt_out').length,
      qualification_status_counts: qualCounts,
      qualified_brands: qualified,
      qualified_vs_goal: tg ? { goal: tg.qualified_brands_goal, gap: qualified - tg.qualified_brands_goal, met: qualified >= tg.qualified_brands_goal } : null,
      opportunities: opps.length,
      opportunity_stage_counts: stageCounts,
      reached_proposal: opps.filter((o) => o.ever_proposal).length,
      confirmed_partnerships: confirmed,
      confirmed_vs_goal: tg ? { goal: tg.confirmed_partnerships_goal, gap: confirmed - tg.confirmed_partnerships_goal, met: confirmed >= tg.confirmed_partnerships_goal } : null,
      confirmed_value_inr: sum(conf, (o) => o.confirmed_value_inr),
      confirmed_value_cash_type_inr: sum(conf.filter((o) => o.support_type === 'cash'), (o) => o.confirmed_value_inr),
      confirmed_value_in_kind_inr: sum(conf.filter((o) => o.support_type === 'in_kind'), (o) => o.confirmed_value_inr),
      open_opportunities: open.length,
      open_pipeline_proposed_value_inr: sum(open, (o) => o.proposed_value_inr),
      cash_collected_inr: null,
      cash_collected_note: 'Not in the source data: there are no payment or bank-receipt records. Confirmed value is a reported amount, not cash.',
      dedupe_report: dedupeReport,
    };
  }

  function campaignFunnel(asOf, campaignId) {
    asOf = normAsOf(asOf);
    const I = interactionsUpTo(asOf);
    const q = qualStates(asOf);
    const opps = oppStates(asOf);
    const rows = [];
    for (const c of T.campaigns) {
      if (campaignId && c.sponsor_campaign_id !== campaignId && c.campaign_name !== campaignId) continue;
      const id = c.sponsor_campaign_id;
      const ci = I.filter((i) => i.sponsor_campaign_id === id);
      const att = (pred) => uniq(ci.filter(pred).map((i) => i.attempt_id)).length;
      const sourced = [...q.values()].filter((r) => r.sponsor_campaign_id === id);
      const qc = {};
      for (const r of sourced) qc[r.qualification_status] = (qc[r.qualification_status] || 0) + 1;
      const co = opps.filter((o) => o.sponsor_campaign_id === id);
      const won = co.filter((o) => o.stage === 'partner_confirmed');
      const closedLost = co.filter((o) => ['lost', 'withdrawn'].includes(o.stage));
      const attempts = uniq(ci.map((i) => i.attempt_id)).length;
      const brandsSourced = sourced.length;
      const r = {
        campaign_id: id, campaign: c.campaign_name, channel: c.channel, channel_type: WARM_CAMPAIGNS.has(id) ? 'warm' : 'cold', owner: c.owner_name,
        planned_start: c.planned_start_at, planned_end: c.planned_end_at,
        attempts, brands_touched: uniq(ci.map((i) => i.brand_id)).length, brands_sourced: brandsSourced,
        replied: att((i) => i.event_type === 'replied'), positive_replies: att((i) => i.event_type === 'replied' && i.outcome === 'positive'),
        neutral_replies: att((i) => i.event_type === 'replied' && i.outcome === 'neutral'),
        not_interested: att((i) => i.event_type === 'replied' && i.outcome === 'not_interested'),
        wrong_contact: att((i) => i.event_type === 'replied' && i.outcome === 'wrong_contact'),
        inbound_or_intro: att((i) => ['web_inbound', 'introduction_received'].includes(i.event_type)),
        meetings_booked: att((i) => i.event_type === 'meeting_booked'), meetings_held: att((i) => i.event_type === 'meeting_held'),
        opt_outs: att((i) => i.event_type === 'opt_out'),
        qualified: qc.qualified || 0, qualification_status_counts: qc,
        opportunities: co.length, open: co.filter((o) => OPEN_STAGES.includes(o.stage)).length,
        confirmed: won.length, lost: co.filter((o) => o.stage === 'lost').length, withdrawn: co.filter((o) => o.stage === 'withdrawn').length,
        confirmed_value_inr: sum(won, (o) => o.confirmed_value_inr), open_proposed_value_inr: sum(co.filter((o) => OPEN_STAGES.includes(o.stage)), (o) => o.proposed_value_inr),
        ever_confirmed: co.filter((o) => o.ever_confirmed).length,
      };
      r.reply_rate = attempts ? +(r.replied / attempts).toFixed(3) : null;
      r.meeting_rate = attempts ? +(r.meetings_held / attempts).toFixed(3) : null;
      r.qualified_rate_of_sourced_brands = brandsSourced ? +(r.qualified / brandsSourced).toFixed(3) : null;
      r.win_rate_of_opportunities = co.length ? +(won.length / co.length).toFixed(3) : null;
      r.win_rate_of_closed = won.length + closedLost.length ? +(won.length / (won.length + closedLost.length)).toFixed(3) : null;
      rows.push(r);
    }
    return { as_of: asOf, campaigns: rows, definitions: {
      attempts: 'unique attempt_id (one source touch and its follow-on events); repeat outreach is a new attempt, not a new brand',
      brands_sourced: 'brands whose latest qualification record names this campaign as its source',
      win_rate_of_opportunities: 'confirmed / all opportunities originated by the campaign (latest stage as of the date)',
      channel_type: 'warm = Warm Partner Introductions, Creator Network Referrals, Partner Interest Form; cold = Brand Discovery Email, Brand Leader LinkedIn, Past Conversation Revival (analyst grouping)',
    } };
  }

  function breakdown(asOf, dimension) {
    asOf = normAsOf(asOf);
    const opps = oppStates(asOf);
    const key = { industry: (o) => o.industry, owner: (o) => o.owner_name, support_type: (o) => o.support_type, channel_type: (o) => o.channel_type, stage: (o) => o.stage, campaign: (o) => o.originating_campaign }[dimension];
    if (!key) return { error: `Unknown dimension ${dimension}. Use industry, owner, support_type, channel_type, stage or campaign.` };
    const groups = new Map();
    for (const o of opps) { const k = key(o) ?? '(none)'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(o); }
    const rows = [...groups.entries()].map(([k, os]) => {
      const won = os.filter((o) => o.stage === 'partner_confirmed');
      return { [dimension]: k, opportunities: os.length, confirmed: won.length, lost: os.filter((o) => o.stage === 'lost').length, withdrawn: os.filter((o) => o.stage === 'withdrawn').length, open: os.filter((o) => OPEN_STAGES.includes(o.stage)).length, confirmed_value_inr: sum(won, (o) => o.confirmed_value_inr), open_proposed_value_inr: sum(os.filter((o) => OPEN_STAGES.includes(o.stage)), (o) => o.proposed_value_inr) };
    }).sort((a, b) => b.confirmed_value_inr - a.confirmed_value_inr || b.opportunities - a.opportunities);
    if (dimension === 'industry') {
      const q = qualStates(asOf);
      for (const r of rows) r.brands = T.brands.filter((b) => b.industry === r.industry).length, r.qualified_brands = [...q.values()].filter((x) => x.qualification_status === 'qualified' && (brandById.get(x.brand_id) || {}).industry === r.industry).length;
    }
    return { as_of: asOf, dimension, rows, note: 'Counts opportunities (deals), not brands; a brand can have several opportunities.' };
  }

  function listOpportunities(asOf, f = {}) {
    let rows = oppStates(asOf);
    if (f.stage) rows = rows.filter((o) => [].concat(f.stage).includes(o.stage));
    if (f.open_only) rows = rows.filter((o) => OPEN_STAGES.includes(o.stage));
    if (f.campaign) rows = rows.filter((o) => o.originating_campaign === f.campaign || o.sponsor_campaign_id === f.campaign);
    if (f.channel_type) rows = rows.filter((o) => o.channel_type === f.channel_type);
    if (f.industry) rows = rows.filter((o) => (o.industry || '').toLowerCase() === String(f.industry).toLowerCase());
    if (f.owner) rows = rows.filter((o) => (o.owner_name || '').toLowerCase().includes(String(f.owner).toLowerCase()));
    if (f.brand) rows = rows.filter((o) => o.brand_name.toLowerCase().includes(String(f.brand).toLowerCase()) || o.brand_id === f.brand);
    if (f.min_days_in_stage != null) rows = rows.filter((o) => o.days_in_stage >= f.min_days_in_stage);
    if (f.support_type) rows = rows.filter((o) => o.support_type === f.support_type);
    return { as_of: normAsOf(asOf), count: rows.length, total_proposed_value_inr: sum(rows, (o) => o.proposed_value_inr), total_confirmed_value_inr: sum(rows, (o) => o.confirmed_value_inr), rows };
  }

  function listBrands(asOf, f = {}) {
    asOf = normAsOf(asOf);
    const cut = cutoffOf(asOf);
    const q = qualStates(asOf);
    const opps = oppStates(asOf);
    const I = interactionsUpTo(asOf);
    const touched = new Set(I.map((i) => i.brand_id));
    let rows = T.brands.filter((b) => ts(b.created_at) <= cut).map((b) => {
      const qr = q.get(b.brand_id);
      const bo = opps.filter((o) => o.brand_id === b.brand_id);
      return { brand_id: b.brand_id, brand_name: b.brand_name, industry: b.industry, owner: b.owner_name, contacts: contactsByBrand.get(b.brand_id) || 0,
        qualification_status: qr ? qr.qualification_status : 'no_record', qualification_reason: qr ? qr.reason : null, source_campaign: qr ? qr.source_campaign_name : null,
        channel_type: qr ? (WARM_CAMPAIGNS.has(qr.sponsor_campaign_id) ? 'warm' : 'cold') : null,
        touched: touched.has(b.brand_id), opportunities: bo.length, opportunity_stages: bo.map((o) => o.stage) };
    });
    if (f.qualification_status) rows = rows.filter((r) => [].concat(f.qualification_status).includes(r.qualification_status));
    if (f.has_opportunity === true) rows = rows.filter((r) => r.opportunities > 0);
    if (f.has_opportunity === false) rows = rows.filter((r) => r.opportunities === 0);
    if (f.industry) rows = rows.filter((r) => (r.industry || '').toLowerCase() === String(f.industry).toLowerCase());
    if (f.source_campaign) rows = rows.filter((r) => r.source_campaign === f.source_campaign);
    if (f.channel_type) rows = rows.filter((r) => r.channel_type === f.channel_type);
    if (f.owner) rows = rows.filter((r) => (r.owner || '').toLowerCase().includes(String(f.owner).toLowerCase()));
    if (f.min_contacts != null) rows = rows.filter((r) => r.contacts >= f.min_contacts);
    return { as_of: asOf, count: rows.length, rows };
  }

  function trend(metric, from, to, interval = 'week') {
    from = from || range.start; to = to || range.end;
    const step = interval === 'day' ? 1 : 7;
    const out = [];
    let d = Date.parse(`${from}T12:00:00+05:30`);
    const end = Date.parse(`${to}T12:00:00+05:30`);
    const pick = {
      confirmed_partnerships: (s) => s.confirmed_partnerships, qualified_brands: (s) => s.qualified_brands, confirmed_value_inr: (s) => s.confirmed_value_inr,
      open_pipeline_proposed_value_inr: (s) => s.open_pipeline_proposed_value_inr, opportunities: (s) => s.opportunities, brands_touched: (s) => s.brands_touched, outreach_attempts: (s) => s.outreach_attempts,
    }[metric];
    if (!pick) return { error: `Unknown metric ${metric}` };
    while (d <= end + 1) {
      const day = istDate(d);
      const s = snapshot(day);
      out.push({ date: day, value: pick(s), goal: metric === 'confirmed_partnerships' ? s.targets_in_force?.confirmed_partnerships_goal ?? null : metric === 'qualified_brands' ? s.targets_in_force?.qualified_brands_goal ?? null : null });
      if (d === end) break;
      d = Math.min(d + step * DAY, end);
    }
    return { metric, interval, series: out };
  }

  function tableRows(table, asOf) {
    asOf = normAsOf(asOf);
    const cut = cutoffOf(asOf);
    switch (table) {
      case 'brands': return T.brands.filter((b) => ts(b.created_at) <= cut);
      case 'contacts': return T.contacts.filter((c) => ts(c.created_at) <= cut);
      case 'campaigns': return T.campaigns;
      case 'interactions': return T.interactions.filter((i) => ts(i.occurred_at) <= cut);
      case 'qualification_latest': return [...qualStates(asOf).values()];
      case 'opportunities_latest': return oppStates(asOf);
      case 'activations': return T.activations.filter((a) => ts(a.linked_at) <= cut);
      case 'targets': return T.targets;
      default: return null;
    }
  }

  function queryRecords({ table, as_of, filters = [], group_by, metric = 'count', field, limit = 25 }) {
    const rows0 = tableRows(table, as_of);
    if (!rows0) return { error: `Unknown table ${table}. Tables: brands, contacts, campaigns, interactions, qualification_latest, opportunities_latest, activations, targets.` };
    let rows = rows0;
    for (const fl of filters) {
      const { field: fd, op = 'eq', value } = fl;
      rows = rows.filter((r) => {
        const v = r[fd];
        switch (op) {
          case 'eq': return String(v).toLowerCase() === String(value).toLowerCase();
          case 'neq': return String(v).toLowerCase() !== String(value).toLowerCase();
          case 'contains': return String(v ?? '').toLowerCase().includes(String(value).toLowerCase());
          case 'in': return (typeof value === 'string' ? value.split(',') : [].concat(value)).map((x) => String(x).trim().toLowerCase()).includes(String(v).toLowerCase());
          case 'gt': return Number(v) > Number(value) || (isNaN(Number(v)) && String(v) > String(value));
          case 'gte': return Number(v) >= Number(value) || (isNaN(Number(v)) && String(v) >= String(value));
          case 'lt': return Number(v) < Number(value) || (isNaN(Number(v)) && String(v) < String(value));
          case 'lte': return Number(v) <= Number(value) || (isNaN(Number(v)) && String(v) <= String(value));
          case 'is_null': return v == null || v === '';
          default: return true;
        }
      });
    }
    const agg = (rs) => metric === 'count' ? rs.length : metric === 'sum' ? sum(rs, (r) => r[field]) : metric === 'avg' ? (rs.length ? +(sum(rs, (r) => r[field]) / rs.length).toFixed(2) : null) : metric === 'count_distinct' ? uniq(rs.map((r) => r[field])).length : null;
    const fieldsAvailable = rows0[0] ? Object.keys(rows0[0]) : [];
    if (group_by) {
      const g = new Map();
      for (const r of rows) { const k = r[group_by] ?? '(none)'; if (!g.has(k)) g.set(k, []); g.get(k).push(r); }
      return { table, as_of: normAsOf(as_of), matched_rows: rows.length, groups: [...g.entries()].map(([k, rs]) => ({ [group_by]: k, value: agg(rs) })).sort((a, b) => b.value - a.value), metric, field: field || null, fields_available: fieldsAvailable };
    }
    return { table, as_of: normAsOf(as_of), matched_rows: rows.length, value: agg(rows), metric, field: field || null, sample_rows: rows.slice(0, Math.min(limit, 50)), fields_available: fieldsAvailable };
  }

  return { T, range, dedupeReport, snapshot, campaignFunnel, breakdown, listOpportunities, listBrands, trend, targetsAt, queryRecords, oppStates, brandById, campById };
}

// ---------- Live 2026 tracker ----------
// The tracker is a Google Sheet (or the bundled seed) with tabs: Lines, Deals, Payments, Creators, InKind, Signals, Tasks.
export function liveSummary(tr) {
  const lines = tr.Lines || [];
  const deals = tr.Deals || [];
  const pays = tr.Payments || [];
  const num = (v) => Number(String(v ?? '').replace(/[^0-9.-]/g, '')) || 0;
  const collectedByDeal = new Map();
  for (const p of pays) collectedByDeal.set(p.deal_id, (collectedByDeal.get(p.deal_id) || 0) + num(p.amount_inr));
  const SIGNED = ['signed', 'invoiced', 'partly_paid', 'paid'];
  const byLine = lines.map((l) => {
    const ds = deals.filter((d) => d.revenue_line === l.line_id);
    const signed = ds.filter((d) => SIGNED.includes(d.stage));
    const cashSigned = sum(signed.filter((d) => d.support_type !== 'in_kind'), (d) => num(d.signed_value_inr));
    const collected = sum(ds, (d) => collectedByDeal.get(d.deal_id) || 0);
    return { line_id: l.line_id, line: l.name, bet: l.bet, base_target_inr: num(l.base_signed_inr), stretch_target_inr: num(l.stretch_signed_inr),
      deals: ds.length, open: ds.filter((d) => ['prospect', 'contacted', 'meeting', 'proposal', 'negotiating'].includes(d.stage)).length,
      pipeline_value_inr: sum(ds.filter((d) => ['contacted', 'meeting', 'proposal', 'negotiating'].includes(d.stage)), (d) => num(d.proposed_value_inr)),
      signed_deals: signed.length, signed_cash_inr: cashSigned, signed_in_kind_inr: sum(signed.filter((d) => d.support_type === 'in_kind'), (d) => num(d.signed_value_inr)),
      collected_inr: collected, pct_of_base: num(l.base_signed_inr) ? +(cashSigned / num(l.base_signed_inr)).toFixed(3) : null };
  });
  const tot = (k) => sum(byLine, (r) => r[k]);
  const inkind = tr.InKind || [];
  const counted = (r) => { const vals = [num(r.declared_value_inr), num(r.market_quote_inr)].filter((v) => v > 0); return vals.length ? Math.min(...vals) : 0; };
  const offset = sum(inkind.filter((r) => String(r.replaces_budget_line || '').trim() && String(r.delivered).toLowerCase() === 'yes'), counted);
  const creators = tr.Creators || [];
  return {
    lines: byLine,
    totals: { base_target_inr: tot('base_target_inr'), stretch_target_inr: tot('stretch_target_inr'), pipeline_value_inr: tot('pipeline_value_inr'), signed_cash_inr: tot('signed_cash_inr'), signed_in_kind_inr: tot('signed_in_kind_inr'), collected_inr: tot('collected_inr'), deals: deals.length, signed_deals: tot('signed_deals') },
    collection_gap_inr: tot('signed_cash_inr') - tot('collected_inr'),
    in_kind: { commitments: inkind.length, delivered: inkind.filter((r) => String(r.delivered).toLowerCase() === 'yes').length, budget_offset_inr: offset, rule: 'Counted only if delivered AND it replaces a planned budget line, at the lower of declared value and market quote.' },
    creators: { roster: creators.length, signed: creators.filter((c) => c.status === 'signed' || c.status === 'drafted').length, drafted: creators.filter((c) => c.status === 'drafted').length, fest_net_inr: sum(creators, (c) => num(c.fest_net_inr)) },
    stage_counts: deals.reduce((m, d) => ((m[d.stage] = (m[d.stage] || 0) + 1), m), {}),
  };
}

// Safe arithmetic for the copilot (numbers, + - * / % ^ and parentheses only).
export function calculate(expr) {
  const s = String(expr).replace(/,/g, '').replace(/\s+/g, '');
  if (!/^[0-9+\-*/%^().eE]+$/.test(s)) return { error: 'Only numbers and + - * / % ^ ( ) are allowed.' };
  let i = 0;
  const peek = () => s[i];
  const num = () => { const m = /^(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+)/.exec(s.slice(i)); if (!m) throw new Error('number expected at ' + i); i += m[0].length; return parseFloat(m[0]); };
  const factor = () => { if (peek() === '(') { i++; const v = expr0(); if (peek() !== ')') throw new Error('missing )'); i++; return v; } if (peek() === '-') { i++; return -factor(); } if (peek() === '+') { i++; return factor(); } return num(); };
  const power = () => { let b = factor(); while (peek() === '^') { i++; b = Math.pow(b, factor()); } return b; };
  const term = () => { let v = power(); while ('*/%'.includes(peek()) && peek()) { const op = s[i++]; const r = power(); v = op === '*' ? v * r : op === '/' ? v / r : v % r; } return v; };
  const expr0 = () => { let v = term(); while ((peek() === '+' || peek() === '-')) { const op = s[i++]; const r = term(); v = op === '+' ? v + r : v - r; } return v; };
  try { const v = expr0(); if (i !== s.length) throw new Error('unexpected ' + s[i]); return { expression: expr, result: +v.toFixed(6) }; } catch (e) { return { error: String(e.message) }; }
}
