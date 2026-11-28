// TEMPORARY latency probe. GET /api/bench?t=<WRITE_TOKEN>
// Times a realistic copilot turn on several Gemini models, and a read of each Apps Script.
export default async function handler(req, res) {
  if (!process.env.WRITE_TOKEN || req.query.t !== process.env.WRITE_TOKEN) return res.status(403).json({ ok: false });
  const key = process.env.GEMINI_API_KEY;
  const models = ['gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash', 'gemini-3-flash-preview'];
  const tools = [{ name: 'get_summary', description: 'Headline sponsorship metrics', parameters: { type: 'OBJECT', properties: { as_of: { type: 'STRING' } } } },
    { name: 'list_deals', description: 'List deals with filters', parameters: { type: 'OBJECT', properties: { stage: { type: 'STRING' } } } }];
  const ask = (model, thinking) => {
    const t0 = Date.now();
    const gc = { temperature: 0.2, maxOutputTokens: 512, ...(thinking === 0 ? { thinkingConfig: { thinkingBudget: 0 } } : thinking === 'low' ? { thinkingConfig: { thinkingLevel: 'low' } } : {}) };
    return fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: 'You are a sponsorship analyst. Use tools for numbers.' }] }, contents: [{ role: 'user', parts: [{ text: 'How many partners did we confirm and what is the open pipeline?' }] }], tools: [{ functionDeclarations: tools }], generationConfig: gc }),
      signal: AbortSignal.timeout(25000),
    }).then(async (r) => { const j = await r.json().catch(() => ({})); const p = (j.candidates?.[0]?.content?.parts || []); return { model, thinking: thinking ?? 'default', ms: Date.now() - t0, status: r.status, out: p.map((x) => x.functionCall ? 'call:' + x.functionCall.name : 'text').join(','), err: j.error?.message?.slice(0, 80) }; })
      .catch((e) => ({ model, thinking: thinking ?? 'default', ms: Date.now() - t0, err: String(e.name) }));
  };
  const runs = [];
  const only = req.query.m ? String(req.query.m).split(',') : null;
  for (const m of (only || models)) runs.push(ask(m, undefined));
  for (const lvl of ['low', 'minimal']) runs.push(ask('gemini-3-flash-preview', lvl));
  if (req.query.stream) {
    const t0 = Date.now();
    runs.push(fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:streamGenerateContent?alt=sse`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'In 120 words, explain why warm intros convert better than cold email for sponsorships.' }] }], generationConfig: { thinkingConfig: { thinkingLevel: 'low' } } }) })
      .then(async (r) => { const rd = r.body.getReader(); let first = 0, n = 0; for (;;) { const { done, value } = await rd.read(); if (done) break; n += value.length; if (!first) first = Date.now() - t0; } return { model: 'stream gemini-3-flash-preview', first_byte_ms: first, ms: Date.now() - t0, bytes: n }; }));
  }
  const timeScript = async (name, url) => { const t0 = Date.now(); try { const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(25000) }); const tx = await r.text(); return { name, ms: Date.now() - t0, bytes: tx.length, status: r.status }; } catch (e) { return { name, ms: Date.now() - t0, err: String(e.name) }; } };
  const sheets = req.query.nosheets ? [] : [timeScript('2025 script', process.env.SAMPLE_SCRIPT_URL), timeScript('2026 script', process.env.TRACKER_SCRIPT_URL)];
  const [m, s] = await Promise.all([Promise.all(runs), Promise.all(sheets)]);
  res.setHeader('cache-control', 'no-store');
  res.status(200).json({ region: process.env.VERCEL_REGION, models: m.sort((a, b) => a.ms - b.ms), sheets: s });
}
