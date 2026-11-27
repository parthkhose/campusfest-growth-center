// POST /api/chat  { system, contents, tools }  -> one Gemini generateContent turn.
// The browser runs the agent loop and executes the tools against the dashboard's own metrics engine,
// so the copilot and the dashboard always use the same numbers. This route only adds the API key.
// Env: GEMINI_API_KEY (required), GEMINI_MODEL (optional; copy a Flash model id from Google AI Studio).
const FALLBACK_MODELS = ['gemini-flash-latest', 'gemini-2.5-flash', 'gemini-flash-lite-latest'];

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
  const payload = {
    systemInstruction: system ? { parts: [{ text: system }] } : undefined,
    contents,
    tools: tools ? [{ functionDeclarations: tools }] : undefined,
    toolConfig: tools ? { functionCallingConfig: { mode: 'AUTO' } } : undefined,
    generationConfig: { temperature: 0.2, maxOutputTokens: 2048 },
  };
  let last;
  for (const model of models) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(payload) });
    const j = await r.json().catch(() => ({}));
    if (r.ok) {
      const cand = (j.candidates || [])[0] || {};
      return res.status(200).json({ ok: true, model, content: cand.content || { role: 'model', parts: [] }, finishReason: cand.finishReason, usage: j.usageMetadata });
    }
    last = { status: r.status, error: (j.error && j.error.message) || `HTTP ${r.status}` };
    if (r.status !== 404 && r.status !== 400) break; // only fall through to another model when this one is unknown
    if (r.status === 400 && !/model/i.test(last.error)) break;
  }
  const hint = last.status === 429 ? 'Gemini free-tier rate limit reached. Wait a minute and retry.' : last.error;
  return res.status(last.status === 429 ? 429 : 502).json({ ok: false, error: hint, tried: models });
}
