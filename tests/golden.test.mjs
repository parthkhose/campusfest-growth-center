// Golden answers computed independently (pandas) from the supplied Sponsor_Dataset.xlsx.
// Run: node tests/golden.test.mjs
import { readFileSync } from 'node:fs';
import { createEngine, calculate } from '../engine.js';

const raw = JSON.parse(readFileSync(new URL('../data/sample-2025.json', import.meta.url)));
const E = createEngine(raw);
let pass = 0, fail = 0;
const norm = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort()) : v);
const eq = (name, got, want) => { const ok = JSON.stringify(norm(got)) === JSON.stringify(norm(want)); ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: got ${JSON.stringify(got)}${ok ? '' : ` want ${JSON.stringify(want)}`}`); };

eq('dedupe report', E.dedupeReport, { interactions: 3, qualification: 1, opportunity_history: 2 });
const snaps = {
  '2025-02-15': [24, 2, 170000, 'Sponsor launch plan'],
  '2025-02-28': [39, 8, 700000, 'Sponsor launch plan'],
  '2025-03-14': [53, 17, 1505000, 'Sponsor launch plan'],
  '2025-03-15': [55, 17, 1505000, 'Sponsor revised plan'],
  '2025-03-31': [60, 23, 2090000, 'Sponsor revised plan'],
  '2025-04-11': [60, 24, 2240000, 'Sponsor revised plan'],
  '2025-04-20': [60, 24, 2240000, 'Sponsor revised plan'],
};
for (const [d, [q, c, v, tv]] of Object.entries(snaps)) {
  const s = E.snapshot(d);
  eq(`snapshot ${d}`, [s.qualified_brands, s.confirmed_partnerships, s.confirmed_value_inr, s.targets_in_force.version], [q, c, v, tv]);
}
const f = E.snapshot('2025-04-20');
eq('final: brands touched / attempts / opps', [f.brands_touched, f.outreach_attempts, f.opportunities], [180, 370, 58]);
eq('final: cash-type vs in-kind', [f.confirmed_value_cash_type_inr, f.confirmed_value_in_kind_inr], [2000000, 240000]);
eq('final: open deals and proposed value', [f.open_opportunities, f.open_pipeline_proposed_value_inr], [26, 1440000]);
eq('final: qualification counts', f.qualification_status_counts, { qualified: 60, engaged: 28, dormant: 63, unqualified: 21, unreviewed: 8 });
eq('2025-04-12 excludes the 13 Apr interaction', E.snapshot('2025-04-12').outreach_attempts, 369);
eq('cash collected unknown', f.cash_collected_inr, null);

const fun = Object.fromEntries(E.campaignFunnel('2025-04-20').campaigns.map((c) => [c.campaign, [c.attempts, c.brands_sourced, c.qualified, c.opportunities, c.confirmed, c.confirmed_value_inr]]));
eq('funnel Warm Partner Introductions', fun['Warm Partner Introductions'], [9, 8, 8, 9, 8, 785000]);
eq('funnel Creator Network Referrals', fun['Creator Network Referrals'], [21, 19, 15, 9, 9, 785000]);
eq('funnel Partner Interest Form', fun['Partner Interest Form'], [18, 17, 13, 7, 7, 670000]);
eq('funnel Brand Leader LinkedIn', fun['Brand Leader LinkedIn'], [54, 28, 10, 12, 0, 0]);
eq('funnel Brand Discovery Email', fun['Brand Discovery Email'], [224, 88, 7, 11, 0, 0]);
eq('funnel Past Conversation Revival', fun['Past Conversation Revival'], [44, 20, 7, 10, 0, 0]);

const cob = E.listOpportunities('2025-03-01', { brand: 'Cobalt Learning' }).rows[0].stage;
eq('Cobalt Learning confirmed on 1 Mar', cob, 'partner_confirmed');
eq('Cobalt Learning withdrawn on 20 Mar', E.listOpportunities('2025-03-20', { brand: 'Cobalt Learning' }).rows[0].stage, 'withdrawn');
eq('qualified brands with no opportunity', E.listBrands('2025-04-20', { qualification_status: 'qualified', has_opportunity: false }).count, 18);
const lostInd = E.breakdown('2025-04-20', 'industry').rows.find((r) => r.industry === 'Media').lost;
eq('Media lost deals', lostInd, 6);
eq('beardo has 2 opportunities', E.listOpportunities('2025-04-20', { brand: 'Beardo' }).count, 2);
eq('query: interactions opt-outs', E.queryRecords({ table: 'interactions', filters: [{ field: 'event_type', op: 'eq', value: 'opt_out' }] }).value, 7);
eq('calculate', calculate('2240000/24').result, 93333.333333);

// Overlay edit: move one negotiating deal to confirmed on 2025-04-05 and check the numbers move only after that date.
const neg = E.listOpportunities('2025-04-20', { stage: 'negotiating' }).rows[0];
const E2 = createEngine(raw, { opportunity_history: [{ opportunity_id: neg.opportunity_id, brand_id: neg.brand_id, brand_name: neg.brand_name, opportunity_name: neg.opportunity_name, stage: 'partner_confirmed', proposed_value_inr: neg.proposed_value_inr, confirmed_value_inr: neg.proposed_value_inr, owner_name: neg.owner_name, effective_at: '2025-04-05T12:00:00+05:30', history_id: 'APP-TEST-1', source: 'app_edit' }] });
eq('edit: confirmed on 4 Apr unchanged', E2.snapshot('2025-04-04').confirmed_partnerships, 24);
eq('edit: confirmed on 20 Apr +1', E2.snapshot('2025-04-20').confirmed_partnerships, 25);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
