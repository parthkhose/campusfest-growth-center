// POST /api/voice  { action: 'tts_stream', text }           -> raw 16-bit mono PCM, streamed as Gemini produces it
//                                                              (x-sample-rate header). First audio in ~1 s.
//                  { action: 'tts', text }                  -> audio/wav (whole clip; kept as a fallback)
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

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(503).json({ ok: false, error: 'GEMINI_API_KEY is not set on the server.' });
  let b;
  try { b = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {}; } catch { return res.status(400).json({ ok: false, error: 'bad JSON' }); }

  if (b.action === 'tts_stream') {
    const text = String(b.text || '').slice(0, 1200).trim();
    if (!text) return res.status(400).json({ ok: false, error: 'text required' });
    const voice = process.env.GEMINI_TTS_VOICE || 'Kore';
    const models = [...new Set([process.env.GEMINI_TTS_MODEL, ...TTS_MODELS].filter(Boolean))];
    let last = 'no model answered';
    for (const model of models) {
      let r;
      try {
        r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify({ contents: [{ parts: [{ text }] }], generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } } }),
          signal: AbortSignal.timeout(25000),
        });
      } catch (e) { last = `${model}: ${e.name}`; continue; }
      if (!r.ok) { last = `${model}: HTTP ${r.status}`; if (r.status === 401 || r.status === 403) break; continue; }
      // Forward each audio chunk as soon as it arrives. Chunks may be raw PCM or WAV-wrapped; strip any WAV header.
      let started = false, buf = '';
      const dec = new TextDecoder();
      const send = (b64, mime) => {
        let pcm = Buffer.from(b64, 'base64');
        let rate = Number((/rate=(\d+)/.exec(mime || '') || [])[1] || 24000);
        if (pcm.slice(0, 4).toString() === 'RIFF') { rate = pcm.readUInt32LE(24); const d = pcm.indexOf('data'); pcm = pcm.slice(d + 8); }
        if (!started) { res.setHeader('content-type', 'application/octet-stream'); res.setHeader('x-sample-rate', String(rate)); res.setHeader('x-model', model); res.setHeader('cache-control', 'no-store'); started = true; }
        res.write(pcm);
      };
      try {
        const rd = r.body.getReader();
        for (;;) {
          const { done, value } = await rd.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const evt = buf.slice(0, i); buf = buf.slice(i + 2);
            const line = evt.split('\n').find((l) => l.startsWith('data: '));
            if (!line) continue;
            let j; try { j = JSON.parse(line.slice(6)); } catch { continue; }
            for (const p of j.candidates?.[0]?.content?.parts || []) if (p.inlineData && p.inlineData.data) send(p.inlineData.data, p.inlineData.mimeType);
          }
        }
      } catch (e) { if (started) return res.end(); last = `${model}: ${e.name}`; continue; }
      if (started) return res.end();
      last = `${model}: no audio`;
    }
    return res.status(502).json({ ok: false, error: last });
  }

  if (b.action === 'tts') {
    const text = String(b.text || '').slice(0, 600).trim();
    if (!text) return res.status(400).json({ ok: false, error: 'text required' });
    const voice = process.env.GEMINI_TTS_VOICE || 'Kore';
    const models = [...new Set([process.env.GEMINI_TTS_MODEL, ...TTS_MODELS].filter(Boolean))];
    let last = 'no model answered';
    for (const model of models) {
      try {
        const r = await gemini(model, {
          contents: [{ parts: [{ text }] }], // plain text only: TTS models read any instruction aloud
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
