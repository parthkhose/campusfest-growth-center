// Data connections and persistence.
// Every source is optional. With nothing connected, the app runs on the bundled copies of the sheets
// and keeps edits and tasks in this browser (localStorage). Connect a Google Sheet to share one source of truth.

const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked: stay in memory */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
export { LS };

export const SETTINGS_KEY = 'gc.settings.v1';
export function getSettings() {
  // Connections come from the server (Vercel env vars) and are not editable in the UI, so the server wins.
  // Browser-saved values only fill gaps, e.g. when running the static files without the /api routes.
  return { sampleScriptUrl: '', trackerScriptUrl: '', sampleSheetId: '', trackerSheetId: '', writeToken: '', ...LS.get(SETTINGS_KEY, {}), ...(window.__GC_ENV__ || {}) };
}
export function saveSettings(s) { LS.set(SETTINGS_KEY, s); }

const SAMPLE_TABS = ['event', 'targets', 'brands', 'contacts', 'campaigns', 'interactions', 'qualification', 'opportunities', 'opportunity_history', 'activations', 'App_Tasks', 'App_Edits'];
const TRACKER_TABS = ['Lines', 'Deals', 'Payments', 'Creators', 'InKind', 'Signals', 'Tasks'];

// ---------- CSV (for the public-sheet fallback) ----------
export function parseCSV(text) {
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
const coerce = (v) => {
  if (v === '' || v == null) return null;
  if (typeof v !== 'string') return v;
  if (/^-?\d+(\.\d+)?$/.test(v) && !/^0\d/.test(v)) return Number(v);
  if (v === 'TRUE') return true; if (v === 'FALSE') return false;
  return v;
};
function toObjects(matrix) {
  if (!matrix.length) return [];
  const h = matrix[0].map((x) => String(x).trim());
  return matrix.slice(1).filter((r) => r.some((c) => c !== '' && c != null)).map((r) => Object.fromEntries(h.map((k, i) => [k, coerce(r[i])])));
}

// ---------- Loading ----------
async function loadFromScript(url) {
  let r = await fetch(`/api/sheet?mode=script&url=${encodeURIComponent(url)}`).catch(() => null);
  if (!r || r.status === 404) r = await fetch(url); // static preview without the /api routes
  if (!r.ok) throw new Error(`Apps Script returned ${r.status}`);
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'Apps Script error');
  const tabs = {};
  for (const [k, rows] of Object.entries(j.tabs)) tabs[k] = rows.map((o) => Object.fromEntries(Object.entries(o).map(([a, b]) => [a, coerce(b === '' ? null : typeof b === 'number' || typeof b === 'boolean' ? b : String(b))])));
  return { tabs, label: `Google Sheet "${j.spreadsheet}" via Apps Script`, fetched_at: j.fetched_at, writable: true };
}
async function loadFromPublicSheet(id, tabNames) {
  const tabs = {};
  await Promise.all(tabNames.map(async (t) => {
    const u = `/api/sheet?mode=csv&id=${encodeURIComponent(id)}&tab=${encodeURIComponent(t)}`;
    const r = await fetch(u).catch(() => null);
    if (!r || !r.ok) return; // tab missing or sheet not public
    tabs[t] = toObjects(parseCSV(await r.text()));
  }));
  if (!Object.keys(tabs).length) throw new Error('Could not read the sheet. Is it shared as "Anyone with the link can view"?');
  return { tabs, label: `Public Google Sheet ${id.slice(0, 8)}… (read-only)`, fetched_at: new Date().toISOString(), writable: false };
}
async function loadBundled(path) {
  const r = await fetch(path);
  return r.json();
}

export async function loadSample() {
  const s = getSettings();
  let src;
  try {
    if (s.sampleScriptUrl) src = await loadFromScript(s.sampleScriptUrl);
    else if (s.sampleSheetId) src = await loadFromPublicSheet(s.sampleSheetId, SAMPLE_TABS);
  } catch (e) { src = { error: String(e.message || e) }; }
  if (src && src.tabs) {
    const t = src.tabs;
    const raw = { event: t.event || [], targets: t.targets || [], brands: t.brands || [], contacts: t.contacts || [], campaigns: t.campaigns || [], interactions: t.interactions || [], qualification: t.qualification || [], opportunities: t.opportunities || [], opportunity_history: t.opportunity_history || [], activations: t.activations || [] };
    const edits = (t.App_Edits || []).map((e) => { try { return { table: e.table, row: JSON.parse(e.row_json) }; } catch { return null; } }).filter(Boolean);
    const tasks = (t.App_Tasks || []).map(normTask);
    return { raw, remoteEdits: edits, remoteTasks: tasks, source: src.label, fetched_at: src.fetched_at, writable: src.writable, connected: true };
  }
  const raw = await loadBundled('./data/sample-2025.json');
  return { raw, remoteEdits: [], remoteTasks: [], source: 'Bundled copy of Sponsor_Dataset.xlsx (original rows)', fetched_at: null, writable: false, connected: false, error: src && src.error };
}

export async function loadTracker() {
  const s = getSettings();
  let src;
  try {
    if (s.trackerScriptUrl) src = await loadFromScript(s.trackerScriptUrl);
    else if (s.trackerSheetId) src = await loadFromPublicSheet(s.trackerSheetId, TRACKER_TABS);
  } catch (e) { src = { error: String(e.message || e) }; }
  if (src && src.tabs) {
    const tr = Object.fromEntries(TRACKER_TABS.map((k) => [k, src.tabs[k] || []]));
    tr.Tasks = tr.Tasks.map(normTask);
    return { tracker: tr, source: src.label, fetched_at: src.fetched_at, writable: src.writable, connected: true };
  }
  const local = LS.get('gc.tracker.local', null);
  if (local) return { tracker: local, source: 'Local copy in this browser (seeded from the 2026 tracker template)', writable: false, connected: false, localCopy: true, error: src && src.error };
  const seed = await loadBundled('./data/tracker-2026-seed.json');
  seed.Tasks = seed.Tasks.map(normTask);
  return { tracker: seed, source: 'Bundled 2026 tracker template (seeded from 2025 data)', writable: false, connected: false, error: src && src.error };
}

export function normTask(t) {
  return { task_id: String(t.task_id || ''), title: t.title || '', owner: t.owner || '', due: t.due ? String(t.due).slice(0, 10) : '', status: t.status || 'open', linked_to: t.linked_to || '', source: t.source || 'manual', created_at: t.created_at || '', notes: t.notes || '' };
}

// ---------- Writing ----------
async function postScript(url, body) {
  const s = getSettings();
  const payload = { ...body, token: window.__GC_SERVER__ ? '' : (s.writeToken || '') }; // on Vercel the server adds WRITE_TOKEN
  let r = await fetch('/api/write', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url, payload }) }).catch(() => null);
  if (!r || r.status === 404) r = await fetch(url, { method: 'POST', body: JSON.stringify(payload) }); // static preview: call Apps Script directly
  const j = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
  if (!j.ok) throw new Error(j.error || 'write failed');
  return j;
}

export async function appendRow(mode, tab, row) {
  const s = getSettings();
  const url = mode === 'sample' ? s.sampleScriptUrl : s.trackerScriptUrl;
  if (!url) return { ok: true, local: true };
  return postScript(url, { action: 'append', tab, row });
}
export async function updateRow(mode, tab, key, id, patch) {
  const s = getSettings();
  const url = mode === 'sample' ? s.sampleScriptUrl : s.trackerScriptUrl;
  if (!url) return { ok: true, local: true };
  return postScript(url, { action: 'update', tab, key, id, patch });
}
