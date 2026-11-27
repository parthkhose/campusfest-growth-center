// POST /api/write  { url: <Apps Script web app URL>, payload: { action, tab, row | key,id,patch, token } }
// Forwards a write to the sheet's Apps Script. The script checks the token and appends or updates the row.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    const { url, payload } = body;
    if (!url || !/^https:\/\/script\.google\.com\//.test(url)) return res.status(400).json({ ok: false, error: 'url must be an Apps Script web app URL' });
    if (!payload || !['append', 'update'].includes(payload.action)) return res.status(400).json({ ok: false, error: 'action must be append or update' });
    if (!payload.token && process.env.WRITE_TOKEN) payload.token = process.env.WRITE_TOKEN;
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload), redirect: 'follow' });
    const text = await r.text();
    res.setHeader('content-type', 'application/json');
    return res.status(200).send(text.startsWith('{') ? text : JSON.stringify({ ok: false, error: `Apps Script returned ${r.status}` }));
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}
