// Voice for the copilot.
// Listening: the browser's Web Speech API (Chrome, Edge, Safari; free, live transcript, Indian English).
//            Browsers without it (Firefox) record with MediaRecorder and transcribe through /api/voice (Gemini).
// Speaking:  Gemini text-to-speech through /api/voice, one sentence group at a time so playback starts early.
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
