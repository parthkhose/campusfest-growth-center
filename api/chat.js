// POST /api/chat  { system, contents, tools }  -> one Gemini generateContent turn.
// The browser runs the agent loop and executes the tools against the dashboard's own metrics engine,
// so the copilot and the dashboard always use the same numbers. This route only adds the API key.
// Env: GEMINI_API_KEY (required), GEMINI_MODEL (optional override), GEMINI_THINKING (optional: minimal|low|medium|high).
// Measured from Vercel on 28 Nov 2026: gemini-3-flash-preview with minimal thinking picks tools in ~1.4 s and writes a
// 120-token answer in ~1.7 s; gemini-flash-latest was overloaded (503s and 25 s+ hangs); the 2.x models are retired.
const FALLBACK_MODELS = ['gemini-3-flash-preview', 'gemini-flash-lite-latest', 'gemini-flash-latest'];
const PER_CALL_MS = 15000;

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
  // Low thinking keeps answers fast; a hard per-call timeout moves on to the next model instead of waiting out a hang.
  const level = process.env.GEMINI_THINKING || 'minimal';
  const started = Date.now(), BUDGET_MS = 52000;
  let last = { status: 502, error: 'No model answered' };
  for (const model of models) {
    for (const thinking of [true, false]) {
      const left = BUDGET_MS - (Date.now() - started);
      if (left < 3000) { last = { status: 504, error: 'Gemini took too long to answer. Try again, or ask a narrower question.' }; break; }
      const payload = { ...base, generationConfig: { temperature: 0.2, maxOutputTokens: 2048, ...(thinking ? { thinkingConfig: { thinkingLevel: level } } : {}) } };
      let r, j;
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
        r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(payload), signal: AbortSignal.timeout(Math.min(left, PER_CALL_MS)) });
        j = await r.json().catch(() => ({}));
      } catch (e) {
        last = { status: 504, error: `${model} timed out` };
        break; // next model
      }
      if (r.ok) {
        const cand = (j.candidates || [])[0] || {};
        return res.status(200).json({ ok: true, model, ms: Date.now() - started, content: cand.content || { role: 'model', parts: [] }, finishReason: cand.finishReason, usage: j.usageMetadata });
      }
      last = { status: r.status, error: (j.error && j.error.message) || `HTTP ${r.status}` };
      if (r.status === 400 && thinking && /thinking/i.test(last.error)) continue; // model has no thinking levels: retry without
      break; // 404 retired, 503 overloaded, 500: try the next model
    }
    if (last.status === 401 || last.status === 403 || (last.status === 429 && /quota|billing/i.test(last.error))) break; // key problems: other models won't help
  }
  const hint = last.status === 429 ? 'Gemini free-tier rate limit reached. Wait a minute and retry.' : last.error;
  return res.status(last.status === 429 ? 429 : last.status === 504 ? 504 : 502).json({ ok: false, error: hint, tried: models });
}
