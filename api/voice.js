// POST /api/voice  { action: 'tts', text }                  -> audio/wav (Gemini text-to-speech)
//                  { action: 'transcribe', audio, mime }     -> { ok, text }  (Gemini speech-to-text, for browsers
//                                                                without the Web Speech API, e.g. Firefox)
// Uses the same GEMINI_API_KEY as the copilot; free tier. Optional env: GEMINI_TTS_MODEL, GEMINI_TTS_VOICE.
const TTS_MODELS = ['gemini-3.8-flash-lite-tts', 'gemini-3.8-flash-tts', 'gemini-3.1-flash-tts-preview', 'gemini-2.5-flash-preview-tts'];
const STT_MODELS = ['gemini-3-flash-preview', 'gemini-3.5-flash-lite', 'gemini-flash-lite-latest'];

// Gemini TTS may return raw 16-bit PCM (audio/L16;rate=24000). Browsers need a WAV header to play it.
function wav(pcm, rate) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

async function gemini(model, body, key, ms) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body), signal: AbortSignal.timeout(ms),
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, j, error: (j.error && j.error.message) || `HTTP ${r.status}` };
}

async function probe(req, res, key) { // TEMPORARY timing check, removed after measuring
  const short = 'We confirmed 24 partners against a goal of 28.';
  const one = async (label, model, text, stream) => {
    const t0 = Date.now();
    const body = { contents: [{ parts: [{ text }] }], generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } } } };
    try {
      if (!stream) { const r = await gemini(model, body, key, 20000); const p = r.j.candidates?.[0]?.content?.parts?.find((x) => x.inlineData); return { label, model, ms: Date.now() - t0, status: r.status, bytes: p ? Math.round(p.inlineData.data.length * 0.75) : 0, mime: p?.inlineData.mimeType, err: r.ok ? undefined : r.error.slice(0, 80) }; }
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
      const rd = r.body.getReader(); let first = 0, n = 0, events = 0, buf = '';
      for (;;) { const { done, value } = await rd.read(); if (done) break; buf += new TextDecoder().decode(value); const k = (buf.match(/\ndata: |^data: /g) || []).length; if (k > events) { events = k; if (!first) first = Date.now() - t0; } n += value.length; }
      return { label, model, status: r.status, first_event_ms: first, ms: Date.now() - t0, events, bytes: n, err: r.ok ? undefined : buf.slice(0, 120) };
    } catch (e) { return { label, model, ms: Date.now() - t0, err: e.name }; }
  };
  const L = 'gemini-3.8-flash-lite-tts';
  const out = [];
  out.push(await one('plain short', L, short));
  out.push(await one('with style prompt', L, 'Read this aloud in a clear, warm, professional voice with a light Indian English accent, at a brisk pace:\n' + short));
  out.push(await one('stream short', L, short, true));
  out.push(await one('stream 3 sentences', L, short + ' Warm channels won 24 of 25 deals. Cold email won none of its 11 deals, so we should stop it.', true));
  out.push(await one('plain short (full model)', 'gemini-3.8-flash-tts', short));
  return res.status(200).json(out);
}

export default async function handler(req, res) {
  if (req.method === 'GET' && process.env.WRITE_TOKEN && req.query.t === process.env.WRITE_TOKEN) return probe(req, res, process.env.GEMINI_API_KEY);
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(503).json({ ok: false, error: 'GEMINI_API_KEY is not set on the server.' });
  let b;
  try { b = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {}; } catch { return res.status(400).json({ ok: false, error: 'bad JSON' }); }

  if (b.action === 'tts') {
    const text = String(b.text || '').slice(0, 600).trim();
    if (!text) return res.status(400).json({ ok: false, error: 'text required' });
    const voice = process.env.GEMINI_TTS_VOICE || 'Kore';
    const models = [...new Set([process.env.GEMINI_TTS_MODEL, ...TTS_MODELS].filter(Boolean))];
    let last = 'no model answered';
    for (const model of models) {
      try {
        const r = await gemini(model, {
          contents: [{ parts: [{ text: `Read this aloud in a clear, warm, professional voice with a light Indian English accent, at a brisk pace:\n${text}` }] }],
          generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
        }, key, 15000);
        const part = r.ok && r.j.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
        if (!part) { last = r.error; if (r.status === 401 || r.status === 403) break; continue; }
        const mime = part.inlineData.mimeType || '';
        let audio = Buffer.from(part.inlineData.data, 'base64');
        if (!/wav/i.test(mime)) audio = wav(audio, Number((/rate=(\d+)/.exec(mime) || [])[1] || 24000));
        res.setHeader('content-type', 'audio/wav');
        res.setHeader('cache-control', 'no-store');
        res.setHeader('x-model', model);
        return res.status(200).send(audio);
      } catch (e) { last = `${model}: ${e.name === 'TimeoutError' ? 'timed out' : e.message}`; }
    }
    return res.status(502).json({ ok: false, error: last });
  }

  if (b.action === 'transcribe') {
    if (!b.audio || String(b.audio).length > 4_000_000) return res.status(400).json({ ok: false, error: 'audio (base64, under ~3 MB) required' });
    let last = 'no model answered';
    for (const model of STT_MODELS) {
      try {
        const r = await gemini(model, {
          contents: [{ role: 'user', parts: [
            { inlineData: { mimeType: String(b.mime || 'audio/webm').split(';')[0], data: b.audio } },
            { text: 'Transcribe exactly what the speaker says. They may mix English and Hindi; write everything in English letters (Roman script). Return only the transcript, no quotes or notes. If nothing is said, return an empty string.' },
          ] }],
          generationConfig: { temperature: 0, maxOutputTokens: 512, thinkingConfig: { thinkingLevel: 'minimal' } },
        }, key, 15000);
        if (!r.ok) { last = r.error; if (r.status === 401 || r.status === 403) break; continue; }
        const text = (r.j.candidates?.[0]?.content?.parts || []).filter((p) => p.text && !p.thought).map((p) => p.text).join(' ').trim();
        return res.status(200).json({ ok: true, text, model });
      } catch (e) { last = `${model}: ${e.name === 'TimeoutError' ? 'timed out' : e.message}`; }
    }
    return res.status(502).json({ ok: false, error: last });
  }
  return res.status(400).json({ ok: false, error: 'action must be tts or transcribe' });
}
