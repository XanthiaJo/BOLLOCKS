// Read AI replies aloud via the browser's speechSynthesis — no server,
// no infra, per-user preference. Only messages arriving live over SSE
// speak; history renders silent. Each AI member gets a stable-ish voice
// and pitch from its name hash so characters don't sound identical.
// *actions* split into their own utterance — a beat before and after,
// read in a flatter register so narration doesn't blur into dialogue.
// The per-message 🔊 replays a line even when the toggle is off.
const ttsOK = 'speechSynthesis' in window;
let ttsOn = localStorage.mp_tts === '1';
let ttsVoices = null;
let ttsGen = 0;                  // bumped on cancel to kill a live chain
const ttsQ = [];                 // pending messages — whole message plays before the next
let ttsPlaying = false;
const TTS_ACT_PAUSE = 320;       // ms beat around *action* narration
const TTS_ACT_PITCH = -0.25;     // actions read lower/flatter than dialogue
const TTS_ACT_RATE = 0.92;       // and a touch slower
const ttsVoicesList = () => ttsVoices ??= (ttsOK ? speechSynthesis.getVoices() : []);
if (ttsOK) speechSynthesis.onvoiceschanged = () => { ttsVoices = null; };

function ttsHash(s) { let h = 0; for (const c of s || '') h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); }

function ttsToggle(btn) {
    ttsOn = !ttsOn;
    localStorage.mp_tts = ttsOn ? '1' : '0';
    if (!ttsOn) ttsCancel();
    btn.textContent = ttsOn ? '🔊' : '🔇';
}

function ttsCancel() {
    ttsGen++;
    ttsQ.length = 0;
    ttsPlaying = false;
    speechSynthesis.cancel();
}

function ttsText(t) {
    return (t || '').replace(/\*+/g, '').replace(/[#_`~>]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Split a line into dialogue/*action* segments. **bold** degrades to a
// plain word (no pause); an unclosed * just loses its asterisk.
function ttsSegs(t) {
    t = (t || '').replace(/\*\*([^*]+)\*\*/g, '$1');
    const segs = [], re = /\*([^*]+)\*/g;
    const push = (raw, act) => { const c = ttsText(raw); if (c) segs.push({ t: c, act }); };
    let last = 0, m;
    while ((m = re.exec(t))) { push(t.slice(last, m.index), false); push(m[1], true); last = re.lastIndex; }
    push(t.slice(last), false);
    return segs;
}

function ttsSpeak(name, text) {
    if (!ttsOK) return;
    const segs = ttsSegs(text);
    if (!segs.length) return;
    ttsQ.push({ name, segs });
    ttsPump();
}

function ttsPump() {
    if (ttsPlaying || !ttsQ.length) return;
    const gen = ttsGen, { name, segs } = ttsQ.shift();
    const voices = ttsVoicesList().filter(v => (v.lang || '').startsWith('en'));
    const h = ttsHash(name);
    const pitch = 0.85 + (h % 40) / 100;   // 0.85–1.25 per character
    const rate = 0.95 + (h % 15) / 100;    // 0.95–1.10
    let i = 0;
    ttsPlaying = true;
    const next = () => {
        if (gen !== ttsGen || i >= segs.length) { ttsPlaying = false; ttsPump(); return; }
        const s = segs[i++];
        const u = new SpeechSynthesisUtterance(s.t);
        if (voices.length) u.voice = voices[h % voices.length];
        u.pitch = Math.max(0.5, pitch + (s.act ? TTS_ACT_PITCH : 0));
        u.rate = rate * (s.act ? TTS_ACT_RATE : 1);
        u.onend = u.onerror = () => setTimeout(next, i < segs.length ? TTS_ACT_PAUSE : 0);
        speechSynthesis.speak(u);
    };
    next();
}

// Auto path — gated on the toggle and the ai kind.
function ttsAuto(m) { if (ttsOn && m.kind === 'ai') ttsSpeak(m.name, m.text); }

// Manual path — a message row's 🔊 always speaks, toggle or not.
function ttsSpeakEl(btn) {
    const li = btn.closest('li');
    ttsSpeak(li.querySelector('.n')?.textContent, li.dataset.txt || li.querySelector('.t')?.textContent);
}

// Composer button state + hide it entirely where speechSynthesis is absent.
const ttsBtn = document.getElementById('ttsbtn');
if (ttsBtn) {
    if (!ttsOK) ttsBtn.remove();
    else ttsBtn.textContent = ttsOn ? '🔊' : '🔇';
}
