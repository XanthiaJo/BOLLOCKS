let token = localStorage.mp_token || '';
let me = '';
let room = Number(localStorage.mp_room || 1);
let es = null;

const $ = id => document.getElementById(id);
const api = (p, b, method = 'POST') => fetch(`/api/${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    ...(method === 'POST' ? { body: JSON.stringify(b || {}) } : {}),
}).then(r => r.json());
const get = p => api(p, null, 'GET');

function addMsg(m) {
    const li = document.createElement('li');
    li.className = 'mes' + (m.kind === 'ai' ? ' ai' : m.kind === 'sys' ? ' sys' : '');
    li.innerHTML = `<span class="n"></span> <span class="t"></span>`;
    li.querySelector('.n').textContent = m.name;
    li.querySelector('.t').textContent = m.text;
    $('msgs').append(li);
    $('msgs').scrollTop = 1e9;
}

async function loadRoom() {
    const r = await get(`room?id=${room}`);
    $('msgs').innerHTML = '';
    (r.messages || []).forEach(addMsg);
    $('members').innerHTML = (r.members || [])
        .map(m => `<div class="member">${m.card_name || m.handle || '?'} <small>${m.kind}</small></div>`)
        .join('');
    document.title = `RP · room ${room}`;
    if (es) es.close();
    es = new EventSource(`/api/stream?room=${room}&token=${token}`);
    es.onmessage = e => {
        const d = JSON.parse(e.data);
        if (d.type === 'message' && d.message.room_id === room) addMsg(d.message);
    };
    renderRooms();
}

async function renderRooms() {
    const { rooms } = await get('rooms');
    $('rooms').innerHTML = (rooms || [])
        .map(r => `<div class="room${r.id === room ? ' on' : ''}" onclick="pick(${r.id})"><span class="n">${r.name}</span></div>`)
        .join('');
}
function pick(id) { room = id; localStorage.mp_room = id; loadRoom(); }

async function newRoom() {
    const name = $('newroom').value.trim();
    if (!name) return;
    $('newroom').value = '';
    const r = await api('rooms', { name });
    if (r.id) pick(r.id);
}

async function loadSettings() {
    const s = await get('settings');
    $('api_url').value = s.apiUrl || '';
    $('api_model').value = s.model || '';
    $('api_key').placeholder = s.key ? 'key set — type to replace' : 'API key';
}
async function saveSettings() {
    const r = await api('settings', {
        apiUrl: $('api_url').value.trim(),
        model: $('api_model').value.trim(),
        key: $('api_key').value.trim(),
    });
    if (r.ok) { $('api_key').value = ''; loadSettings(); }
}

async function say() {
    const text = $('in').value.trim();
    if (!text) return;
    $('in').value = '';
    await api('say', { room, name: me, text });
}
async function gen() {
    const r = await api('generate', { room });
    if (r.error) alert(r.error);
}

async function start() {
    $('app').classList.add('on');
    const m = await get('me');
    me = m.handle || 'you';
    await Promise.all([loadRoom(), loadSettings()]);
}

start();
