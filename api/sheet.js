// GET /api/sheet?mode=script&url=<Apps Script web app URL>   -> JSON of every tab (read through the owner's script)
// GET /api/sheet?mode=csv&id=<spreadsheet id>&tab=<tab name>  -> CSV of one tab of a link-shared sheet
// Server-side so the browser never hits CORS limits. No dependencies.
export default async function handler(req, res) {
  try {
    const { mode, url, id, tab } = req.query || {};
    if (mode === 'script') {
      if (!url || !/^https:\/\/script\.google(usercontent)?\.com\//.test(url)) return res.status(400).json({ ok: false, error: 'url must be an Apps Script web app URL' });
      const r = await fetch(url, { redirect: 'follow' });
      const text = await r.text();
      res.setHeader('content-type', 'application/json');
      res.setHeader('cache-control', 'no-store');
      return res.status(r.ok ? 200 : 502).send(text);
    }
    if (mode === 'csv') {
      if (!id || !/^[A-Za-z0-9_-]{20,}$/.test(id) || !tab) return res.status(400).json({ ok: false, error: 'id and tab are required' });
      const u = `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&headers=1&sheet=${encodeURIComponent(tab)}`;
      const r = await fetch(u, { redirect: 'follow' });
      const text = await r.text();
      if (!r.ok || text.startsWith('<!DOCTYPE')) return res.status(403).json({ ok: false, error: 'Sheet is not readable. Share it as "Anyone with the link can view", or connect the Apps Script URL instead.' });
      res.setHeader('content-type', 'text/csv; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      return res.status(200).send(text);
    }
    return res.status(400).json({ ok: false, error: 'mode must be script or csv' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}
