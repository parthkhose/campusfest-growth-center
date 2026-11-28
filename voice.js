// Voice for the copilot.
// Listening: the browser's Web Speech API (Chrome, Edge, Safari; free, live transcript, Indian English).
//            Browsers without it (Firefox) record with MediaRecorder and transcribe through /api/voice (Gemini).
// Speaking:  Gemini text-to-speech through /api/voice, one sentence group at a time so playback starts early.
//            Falls back to the browser's built-in voices if Gemini TTS is unavailable or rate-limited.

const W = typeof window !== 'undefined' ? window : {}; // also loads in Node for the tool tests
const SR = W.SpeechRecognition || W.webkitSpeechRecognition;
let rec = null, mediaRec = null, chunks = [], listening = false;
let speakId = 0, current = null;

export const canListen = () => !!SR || !!(typeof navigator !== 'undefined' && navigator.mediaDevices && W.MediaRecorder);

// ---------- listening ----------
export function startListening({ onInterim, onFinal, onState, onError }) {
  stopSpeaking();
  if (SR) {
    rec = new SR();
    rec.lang = 'en-IN'; rec.interimResults = true; rec.continuous = false; rec.maxAlternatives = 1;
    let finalText = '';
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += t; else interim += t;
      }
      onInterim((finalText + ' ' + interim).trim());
    };
    rec.onerror = (e) => { if (e.error !== 'no-speech' && e.error !== 'aborted') onError(e.error === 'not-allowed' ? 'Microphone access was blocked. Allow it in the browser’s site settings.' : `Speech recognition error: ${e.error}`); };
    rec.onend = () => { listening = false; onState(false); if (finalText.trim()) onFinal(finalText.trim()); };
    rec.start(); listening = true; onState(true);
    return;
  }
  // Fallback: record, then transcribe on the server.
  navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
    chunks = [];
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : (MediaRecorder.isTypeSupported('audio/ogg;codecs=opus') ? 'audio/ogg;codecs=opus' : '');
    mediaRec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    mediaRec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    mediaRec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      listening = false; onState(false);
      const blob = new Blob(chunks, { type: mediaRec.mimeType || 'audio/webm' });
      if (blob.size < 2000) return;
      onInterim('Transcribing…');
      try {
        const b64 = await new Promise((ok) => { const fr = new FileReader(); fr.onload = () => ok(String(fr.result).split(',')[1]); fr.readAsDataURL(blob); });
        const r = await fetch('/api/voice', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'transcribe', audio: b64, mime: blob.type }) });
        const j = await r.json();
        if (!j.ok) throw new Error(j.error);
        onInterim(j.text || ''); if (j.text) onFinal(j.text);
      } catch (e) { onInterim(''); onError(`Could not transcribe: ${e.message}`); }
    };
    mediaRec.start(); listening = true; onState(true);
    setTimeout(() => { if (mediaRec && mediaRec.state === 'recording') mediaRec.stop(); }, 30000); // 30 s cap
  }).catch(() => onError('Microphone access was blocked. Allow it in the browser’s site settings.'));
}
export function stopListening() {
  if (rec && listening) rec.stop();
  if (mediaRec && mediaRec.state === 'recording') mediaRec.stop();
}
export const isListening = () => listening;

// ---------- speaking ----------
// Markdown answer -> plain sentences that read well aloud (₹22.4L -> "22.4 lakh rupees"; tables skipped).
export function toSpeech(md) {
  return String(md || '')
    .split('\n').filter((l) => !/^\s*\|/.test(l)).join('\n')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_`#>]/g, '')
    .replace(/₹\s?([\d.,]+)\s?Cr\b/g, '$1 crore rupees')
    .replace(/₹\s?([\d.,]+)\s?L\b/g, '$1 lakh rupees')
    .replace(/₹\s?([\d.,]+)\s?k\b/gi, '$1 thousand rupees')
    .replace(/₹\s?([\d,]+)/g, '$1 rupees')
    .replace(/(\d)\s?%/g, '$1 percent')
    .replace(/\bvs\.?\b/g, 'versus')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/\s*\n+\s*/g, '. ').replace(/\.\s*\./g, '.').replace(/\s{2,}/g, ' ')
    .trim();
}
function groups(text, max = 260, cap = 900) {
  const sents = text.slice(0, cap).split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean); // a full stop needs a space after it, so 22.4 stays whole
  const out = []; let cur = '';
  for (const s of sents) { if ((cur + ' ' + s).length > max && cur) { out.push(cur); cur = s; } else cur = (cur + ' ' + s).trim(); }
  if (cur) out.push(cur);
  return out;
}
const tts = (text) => fetch('/api/voice', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'tts', text }) })
  .then((r) => (r.ok && /audio/.test(r.headers.get('content-type') || '') ? r.blob() : Promise.reject(new Error('tts unavailable'))));

function browserSpeak(text, id) {
  return new Promise((done) => {
    if (!window.speechSynthesis || id !== speakId) return done();
    const u = new SpeechSynthesisUtterance(text);
    const vs = speechSynthesis.getVoices();
    u.voice = vs.find((v) => /en-IN/i.test(v.lang)) || vs.find((v) => /^en/i.test(v.lang)) || null;
    u.rate = 1.05; u.onend = done; u.onerror = done;
    speechSynthesis.speak(u);
  });
}

export async function speak(md, { onState } = {}) {
  stopSpeaking();
  const id = ++speakId;
  const parts = groups(toSpeech(md));
  if (!parts.length) return;
  onState && onState(true);
  // Ask for the first two groups at once, then keep one request ahead of playback.
  const pending = parts.map(() => null);
  const want = (i) => { if (i < parts.length && !pending[i]) pending[i] = tts(parts[i]).catch(() => null); };
  want(0); want(1);
  let fallback = false;
  for (let i = 0; i < parts.length && id === speakId; i++) {
    want(i + 1);
    const blob = fallback ? null : await pending[i];
    if (id !== speakId) break;
    if (!blob) { fallback = true; await browserSpeak(parts[i], id); continue; }
    await new Promise((done) => {
      const url = URL.createObjectURL(blob);
      current = new Audio(url);
      current.onended = current.onerror = () => { URL.revokeObjectURL(url); done(); };
      current.play().catch(() => { fallback = true; current = null; browserSpeak(parts[i], id).then(done); });
    });
  }
  if (id === speakId) { current = null; onState && onState(false); }
}
export function stopSpeaking() {
  speakId++;
  if (current) { current.pause(); current = null; }
  if (window.speechSynthesis) speechSynthesis.cancel();
}
export const isSpeaking = () => !!current || (window.speechSynthesis && speechSynthesis.speaking);
