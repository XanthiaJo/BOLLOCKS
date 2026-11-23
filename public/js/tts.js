// Read AI replies aloud via the browser's speechSynthesis — no server,
// no infra, per-user preference. Only messages arriving live over SSE
// speak; history renders silent. Each AI member gets a stable-ish voice
// and pitch from its name hash so characters don't sound identical.
// The per-message 🔊 replays a line even when the toggle is off.
const ttsOK = 'speechSynthesis' in window;
let ttsOn = localStorage.mp_tts === '1';
let ttsVoices = null;
const ttsVoicesList = () => ttsVoices ??= (ttsOK ? speechSynthesis.getVoices() : []);
if (ttsOK) speechSynthesis.onvoiceschanged = () => { ttsVoices = null; };

function ttsHash(s) { let h = 0; for (const c of s || '') h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); }

function ttsToggle(btn) {
    ttsOn = !ttsOn;
    localStorage.mp_tts = ttsOn ? '1' : '0';
    if (!ttsOn) speechSynthesis.cancel();
    btn.textContent = ttsOn ? '🔊' : '🔇';
}

function ttsText(t) {
    return (t || '').replace(/\*+/g, '').replace(/[#_`~>]/g, ' ').replace(/\s+/g, ' ').trim();
}

function ttsSpeak(name, text) {
    if (!ttsOK) return;
    const clean = ttsText(text);
    if (!clean) return;
    const u = new SpeechSynthesisUtterance(clean);
    const voices = ttsVoicesList().filter(v => (v.lang || '').startsWith('en'));
    if (voices.length) u.voice = voices[ttsHash(name) % voices.length];
    const h = ttsHash(name);
    u.pitch = 0.85 + (h % 40) / 100;   // 0.85–1.25 per character
    u.rate = 0.95 + (h % 15) / 100;    // 0.95–1.10
    speechSynthesis.speak(u);
}

// Auto path — gated on the toggle and the ai kind.
function ttsAuto(m) { if (ttsOn && m.kind === 'ai') ttsSpeak(m.name, m.text); }

// Manual path — a message row's 🔊 always speaks, toggle or not.
function ttsSpeakEl(btn) {
    const li = btn.closest('li');
    ttsSpeak(li.querySelector('.n')?.textContent, li.querySelector('.t')?.textContent);
}

// Composer button state + hide it entirely where speechSynthesis is absent.
const ttsBtn = document.getElementById('ttsbtn');
if (ttsBtn) {
    if (!ttsOK) ttsBtn.remove();
    else ttsBtn.textContent = ttsOn ? '🔊' : '🔇';
}
