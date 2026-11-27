// POST /api/chat  { system, contents, tools }  -> one Gemini generateContent turn.
// The browser runs the agent loop and executes the tools against the dashboard's own metrics engine,
// so the copilot and the dashboard always use the same numbers. This route only adds the API key.
// Env: GEMINI_API_KEY (required), GEMINI_MODEL (optional; copy a Flash model id from Google AI Studio).
const FALLBACK_MODELS = ['gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-2.5-flash'];

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(503).json({ ok: false, error: 'GEMINI_API_KEY is not set on the server.' });
  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {}; } catch { return res.status(400).json({ ok: false, error: 'bad JSON' }); }
  const { system, contents, tools } = body;
  if (!Array.isArray(contents) || !contents.length) return res.status(400).json({ ok: false, error: 'contents required' });
  if (JSON.stringify(body).length > 900000) return res.status(413).json({ ok: false, error: 'conversation too long; start a new chat' });

  const models = [...new Set([process.env.GEMINI_MODEL, ...FALLBACK_MODELS].filter(Boolean))];
  const base = {
    systemInstruction: system ? { parts: [{ text: system }] } : undefined,
    contents,
    tools: tools ? [{ functionDeclarations: tools }] : undefined,
    toolConfig: tools ? { functionCallingConfig: { mode: 'AUTO' } } : undefined,
  };
  // Keep each model call short: a small thinking budget, and a hard per-call timeout so one slow
  // model falls through to the next instead of hitting Vercel's function limit (HTTP 504).
  const started = Date.now(), BUDGET_MS = 52000;
  let last = { status: 502, error: 'No model answered' };
  for (const model of models) {
    for (const thinking of [true, false]) {
      const left = BUDGET_MS - (Date.now() - started);
      if (left < 4000) { last = { status: 504, error: 'Gemini took too long to answer. Try again, or ask a narrower question.' }; break; }
      const payload = { ...base, generationConfig: { temperature: 0.2, maxOutputTokens: 2048, ...(thinking ? { thinkingConfig: { thinkingBudget: 512 } } : {}) } };
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), Math.min(left, 25000));
      let r, j;
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
        r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(payload), signal: ctrl.signal });
        j = await r.json().catch(() => ({}));
      } catch (e) {
        clearTimeout(timer);
        last = { status: 504, error: `${model} timed out` };
        break; // try the next model
      }
      clearTimeout(timer);
      if (r.ok) {
        const cand = (j.candidates || [])[0] || {};
        return res.status(200).json({ ok: true, model, content: cand.content || { role: 'model', parts: [] }, finishReason: cand.finishReason, usage: j.usageMetadata });
      }
      last = { status: r.status, error: (j.error && j.error.message) || `HTTP ${r.status}` };
      if (r.status === 400 && thinking && /thinking/i.test(last.error)) continue; // model doesn't accept a thinking budget: retry without
      break;
    }
    if (last.status === 429 || last.status === 401 || last.status === 403) break; // key problems: other models won't help
  }
  const hint = last.status === 429 ? 'Gemini free-tier rate limit reached. Wait a minute and retry.' : last.error;
  return res.status(last.status === 429 ? 429 : last.status === 504 ? 504 : 502).json({ ok: false, error: hint, tried: models });
}
