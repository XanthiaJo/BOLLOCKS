// Dictation: composer mic → /api/stt (whisper sidecar) → transcript lands
// in the input for a sanity check before sending — ASR will occasionally
// hear a name wrong, so nothing posts directly. The button only appears
// when the server reports a reachable STT backend.
const sttBtn = document.getElementById('micbtn');
let sttRec = null, sttStream = null;

if (sttBtn) {
    fetch('/api/stt', { headers: { Authorization: 'Bearer ' + (localStorage.mp_token || '') } })
        .then(r => r.json())
        .then(d => {
            if (d?.enabled && navigator.mediaDevices?.getUserMedia && window.MediaRecorder) sttBtn.style.display = '';
            else sttBtn.remove();
        })
        .catch(() => sttBtn.remove());
}

function sttToggle(btn) {
    if (sttRec) { sttRec.stop(); return; }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
        sttStream = stream;
        const rec = sttRec = new MediaRecorder(stream);
        const chunks = [];
        rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
        rec.onstop = () => {
            const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
            sttRec = null;
            sttStream?.getTracks().forEach(t => t.stop());
            sttStream = null;
            btn.textContent = '🎤';
            btn.classList.remove('rec');
            sttSend(blob);
        };
        rec.start();
        btn.textContent = '⏹';
        btn.classList.add('rec');
    }).catch(() => { btn.title = 'Microphone access blocked'; });
}

function sttSend(blob) {
    fetch(`/api/stt?room=${localStorage.mp_room || 1}`, {
        method: 'POST',
        headers: {
            'Content-Type': blob.type.split(';')[0] || 'audio/webm',
            Authorization: 'Bearer ' + (localStorage.mp_token || ''),
        },
        body: blob,
    }).then(r => r.status === 401 ? location = '/login.html' : r.json())
        .then(d => {
            if (!d?.text) return;
            const inp = document.getElementById('in');
            inp.value = (inp.value ? inp.value.replace(/\s+$/, '') + ' ' : '') + d.text;
            inp.dispatchEvent(new Event('input')); // keep the auto-grow in sync
            inp.focus();
        })
        .catch(() => {});
}
