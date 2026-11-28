// Voice for the copilot.
// Listening: the browser's Web Speech API (Chrome, Edge, Safari; free, live transcript, Indian English).
//            Browsers without it (Firefox) record with MediaRecorder and transcribe through /api/voice (Gemini).
// Speaking:  Gemini text-to-speech streamed through /api/voice and played as it arrives (first audio ~1 s).
//            Falls back to the browser's built-in voices if Gemini TTS is unavailable or rate-limited.

const W = typeof window !== 'undefined' ? window : {}; // also loads in Node for the tool tests
const SR = W.SpeechRecognition || W.webkitSpeechRecognition;
let rec = null, mediaRec = null, chunks = [], listening = false;
let speakId = 0, current = null;

export const canListen = () => !!(typeof navigator !== 'undefined' && navigator.mediaDevices && W.MediaRecorder);

// ---------- listening ----------
// Two engines run together. The browser's Web Speech API gives a live transcript, but in some browsers (the
// Claude desktop app's built-in browser, Brave, some Edge setups, behind some VPNs) it fails with "network"
// because it relies on Google's speech servers. So the microphone is also recorded; if Web Speech fails, the
// recording is transcribed by Gemini through /api/voice, with no need to speak again, and Web Speech is
// skipped from then on. Recording stops by itself after a short silence.
const SR_BROKEN = 'gc.voice.srBroken';
const srOk = () => { try { return !!SR && localStorage.getItem(SR_BROKEN) !== '1'; } catch { return !!SR; } };
let stream = null, audioCtx = null, silenceTimer = null, cb = null, srDone = false, srText = '', useRecording = false;

function cleanup() {
  clearInterval(silenceTimer); silenceTimer = null;
  if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
}
function finish(text) {
  if (!listening) return;
  listening = false; cleanup(); cb.onState(false);
  if (text && text.trim()) cb.onFinal(text.trim()); else cb.onInterim('');
}
async function transcribe(blob) {
  cb.onInterim('Transcribing…');
  try {
    const b64 = await new Promise((ok) => { const fr = new FileReader(); fr.onload = () => ok(String(fr.result).split(',')[1]); fr.readAsDataURL(blob); });
    const r = await fetch('/api/voice', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'transcribe', audio: b64, mime: blob.type }) });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error);
    return j.text || '';
  } catch (e) { cb.onError(`Could not transcribe: ${e.message}`); return ''; }
}

export async function startListening(callbacks) {
  stopSpeaking();
  cb = callbacks; srDone = false; srText = ''; useRecording = !srOk();
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
  catch { return cb.onError('Microphone access was blocked. Allow it in the browser’s site settings, then try again.'); }
  listening = true; cb.onState(true);

  // 1) Record (always), with silence detection.
  chunks = [];
  const mime = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find((m) => W.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
  mediaRec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  mediaRec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  mediaRec.onstop = async () => {
    if (!useRecording) return; // Web Speech handled it
    const blob = new Blob(chunks, { type: mediaRec.mimeType || 'audio/webm' });
    finish(blob.size < 3000 ? '' : await transcribe(blob));
  };
  mediaRec.start(250);
  try {
    audioCtx = new (W.AudioContext || W.webkitAudioContext)();
    const an = audioCtx.createAnalyser(); an.fftSize = 1024;
    audioCtx.createMediaStreamSource(stream).connect(an);
    const buf = new Float32Array(an.fftSize);
    let heard = false, quietMs = 0; const started = Date.now();
    silenceTimer = setInterval(() => {
      an.getFloatTimeDomainData(buf);
      const rms = Math.sqrt(buf.reduce((s, v) => s + v * v, 0) / buf.length);
      if (rms > 0.02) { heard = true; quietMs = 0; } else quietMs += 100;
      const tooQuiet = !heard && Date.now() - started > 7000, doneTalking = heard && quietMs > 1400, tooLong = Date.now() - started > 30000;
      if (tooQuiet || doneTalking || tooLong) stopListening();
    }, 100);
  } catch { /* no Web Audio: user stops with the mic button; 30 s cap below */ setTimeout(() => listening && stopListening(), 30000); }

  // 2) Live transcript from Web Speech, when it works here.
  if (!useRecording) {
    rec = new SR();
    rec.lang = 'en-IN'; rec.interimResults = true; rec.continuous = true; rec.maxAlternatives = 1;
    rec.onresult = (e) => {
      let interim = '';
      srText = '';
      for (let i = 0; i < e.results.length; i++) { const t = e.results[i][0].transcript; if (e.results[i].isFinal) srText += t; else interim += t; }
      cb.onInterim((srText + ' ' + interim).trim());
    };
    rec.onerror = (e) => {
      if (['network', 'service-not-allowed', 'language-not-supported'].includes(e.error)) {
        // Web Speech can't reach its servers here: switch to the recording for this question and the next ones.
        try { localStorage.setItem(SR_BROKEN, '1'); } catch { /* */ }
        useRecording = true; srDone = true;
        cb.onInterim('Listening…');
      } else if (e.error === 'not-allowed') { cb.onError('Microphone access was blocked. Allow it in the browser’s site settings, then try again.'); useRecording = false; finish(''); }
    };
    rec.onend = () => { srDone = true; if (!useRecording && listening && mediaRec.state !== 'recording') finish(srText); };
    try { rec.start(); } catch { useRecording = true; }
  }
}
export function stopListening() {
  if (!listening) return;
  clearInterval(silenceTimer); silenceTimer = null;
  if (mediaRec && mediaRec.state === 'recording') mediaRec.stop();
  if (!useRecording) {
    // Use Web Speech's text; if it caught nothing, transcribe the recording instead.
    const done = async () => { if (srText.trim()) return finish(srText); const blob = new Blob(chunks, { type: (mediaRec && mediaRec.mimeType) || 'audio/webm' }); finish(blob.size < 3000 ? '' : await transcribe(blob)); };
    if (rec && !srDone) { rec.onend = () => setTimeout(done, 50); rec.stop(); } else setTimeout(done, 50);
  }
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

function browserSpeak(text, id) {
  return new Promise((done) => {
    if (!W.speechSynthesis || id !== speakId) return done();
    const u = new SpeechSynthesisUtterance(text);
    const vs = speechSynthesis.getVoices();
    u.voice = vs.find((v) => /en-IN/i.test(v.lang)) || vs.find((v) => /^en/i.test(v.lang)) || null;
    u.rate = 1.05; u.onend = done; u.onerror = done;
    speechSynthesis.speak(u);
  });
}

// Streamed playback: /api/voice sends raw 16-bit PCM as Gemini produces it; each piece is scheduled on a
// Web Audio clock right after the previous one, so speech starts about a second after the answer appears.
let actx = null, playing = [], abortCtl = null;
export function primeAudio() { // call from a click/keypress so the browser allows audio later
  try { actx = actx || new (W.AudioContext || W.webkitAudioContext)(); if (actx.state === 'suspended') actx.resume(); } catch { /* no Web Audio */ }
}
async function streamSpeak(text, id, onFirst) {
  primeAudio();
  if (!actx) throw new Error('no audio');
  abortCtl = new AbortController();
  const r = await fetch('/api/voice', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'tts_stream', text }), signal: abortCtl.signal });
  if (!r.ok || !r.body) throw new Error('tts unavailable');
  const rate = Number(r.headers.get('x-sample-rate') || 24000);
  const rd = r.body.getReader();
  let t = 0, carry = null, first = true;
  for (;;) {
    const { done, value } = await rd.read();
    if (done || id !== speakId) break;
    let bytes = value;
    if (carry) { const m = new Uint8Array(carry.length + bytes.length); m.set(carry); m.set(bytes, carry.length); bytes = m; carry = null; }
    if (bytes.length % 2) { carry = bytes.slice(-1); bytes = bytes.slice(0, -1); }
    if (!bytes.length) continue;
    const n = bytes.length / 2, dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    const buf = actx.createBuffer(1, n, rate), ch = buf.getChannelData(0);
    for (let i = 0; i < n; i++) ch[i] = dv.getInt16(i * 2, true) / 32768;
    const src = actx.createBufferSource(); src.buffer = buf; src.connect(actx.destination);
    if (first) { t = actx.currentTime + 0.08; first = false; onFirst && onFirst(); }
    t = Math.max(t, actx.currentTime + 0.02);
    src.start(t); t += buf.duration; playing.push(src);
  }
  if (first) throw new Error('no audio');
  // wait until the last scheduled piece has played
  await new Promise((done) => { const left = Math.max(0, (t - actx.currentTime) * 1000); setTimeout(done, left + 50); });
}

export async function speak(md, { onState } = {}) {
  stopSpeaking();
  const id = ++speakId;
  const text = toSpeech(md).slice(0, 1200);
  if (!text) return;
  onState && onState(true);
  let heard = false;
  try { await streamSpeak(text, id, () => { heard = true; }); }
  catch (e) {
    if (id !== speakId || e.name === 'AbortError' || heard) { if (id === speakId) { playing = []; onState && onState(false); } return; } // don't restart a half-spoken answer
    for (const part of groups(text)) { if (id !== speakId) break; await browserSpeak(part, id); } // backup: the browser's own voice
  }
  if (id === speakId) { playing = []; onState && onState(false); }
}
export function stopSpeaking() {
  speakId++;
  if (abortCtl) { try { abortCtl.abort(); } catch { /* */ } abortCtl = null; }
  for (const s of playing) { try { s.stop(); } catch { /* already ended */ } }
  playing = [];
  if (current) { current.pause(); current = null; }
  if (W.speechSynthesis) speechSynthesis.cancel();
}
export const isSpeaking = () => playing.length > 0 || (W.speechSynthesis && speechSynthesis.speaking);
