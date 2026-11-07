let token = localStorage.mp_token || '';
let me = localStorage.mp_handle || '';
const ROOM = 1;

const api = (p, b) => fetch(`/api/${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(b || {}),
}).then(r => r.json());

async function doLogin() {
    const r = await api('login', { handle: h.value, password: p.value });
    if (!r.token) return alert(r.error || 'login failed');
    localStorage.mp_token = token = r.token;
    localStorage.mp_handle = me = r.handle;
    start();
}

function addMsg(m) {
    const li = document.createElement('li');
    li.className = 'mes';
    li.innerHTML = `<span class="n">${m.name}</span> <span class="t"></span>`;
    li.querySelector('.t').textContent = m.text;
    msgs.append(li);
    msgs.scrollTop = 1e9;
}

async function start() {
    login.style.display = 'none';
    chat.style.display = 'block';
    const r = await fetch(`/api/room?id=${ROOM}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json());
    msgs.innerHTML = '';
    (r.messages || []).forEach(addMsg);
    const es = new EventSource(`/api/stream?room=${ROOM}&token=${token}`);
    es.onmessage = e => { const d = JSON.parse(e.data); if (d.type === 'message') addMsg(d.message); };
}

async function say() {
    const text = in_.value.trim();
    if (!text) return;
    in_.value = '';
    await api('say', { room: ROOM, name: me, text });
}

async function gen() {
    const r = await api('generate', { room: ROOM });
    if (r.error) alert(r.error);
}

// aliases for the element ids used above
const login = document.getElementById('login'),
      chat = document.getElementById('chat'),
      h = document.getElementById('h'), p = document.getElementById('p'),
      msgs = document.getElementById('msgs'),
      in_ = document.getElementById('in');

if (token) start();
