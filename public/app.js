let token = localStorage.mp_token || '';
let me = '';
let room = Number(localStorage.mp_room || 1);
let es = null;

const AS = new URLSearchParams(location.search).get('as') || '';
const $ = id => document.getElementById(id);
const api = (p, b, method = 'POST') => fetch(`/api/${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(AS ? { 'X-As-User': AS } : {}) },
    ...(method === 'POST' ? { body: JSON.stringify(b || {}) } : {}),
}).then(r => r.json());
const get = p => api(p, null, 'GET');

// Minimal markdown for RP text: *i* **b** ***bi*** _i_ __b__ ~~s~~ `code` #..####
function md(src) {
    const esc = String(src ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return esc
        .replace(/^####\s*(.+)$/gm, '<h5>$1</h5>')
        .replace(/^###\s*(.+)$/gm, '<h4>$1</h4>')
        .replace(/^##\s*(.+)$/gm, '<h3>$1</h3>')
        .replace(/^#\s*(.+)$/gm, '<h2>$1</h2>')
        .replace(/`([^`\n]+)`/g, '<code>$1</code>')
        .replace(/\*\*\*([^*]+)\*\*\*/g, '<b><i>$1</i></b>')
        .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
        .replace(/\*([^*\n]+)\*/g, '<i>$1</i>')
        .replace(/__([^_]+)__/g, '<b>$1</b>')
        .replace(/_([^_\n]+)_/g, '<i>$1</i>')
        .replace(/~~([^~]+)~~/g, '<s>$1</s>');
}

function addMsg(m) {
    const li = document.createElement('li');
    li.className = 'mes' + (m.kind === 'ai' ? ' ai' : m.kind === 'sys' ? ' sys' : '');
    li.innerHTML = `<span class="n"></span> <span class="t"></span>`;
    li.querySelector('.n').textContent = m.name;
    li.querySelector('.t').innerHTML = md(m.text);
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
    es = new EventSource(`/api/stream?room=${room}&token=${token}${AS ? '&as=' + AS : ''}`);
    es.onmessage = e => {
        const d = JSON.parse(e.data);
        if (d.type === 'message' && d.message.room_id === room) addMsg(d.message);
    };
    renderRooms();
    renderWorld();
}

async function renderRooms() {
    const { rooms } = await get('rooms');
    $('rooms').innerHTML = (rooms || [])
        .map(r => `<div class="room${r.id === room ? ' on' : ''}" onclick="pick(${r.id})"><span class="n">${r.name}</span></div>`)
        .join('');
}
function pick(id) { room = id; localStorage.mp_room = id; loadRoom(); }

async function renderWorld() {
    const { books, rooms } = await get('world/books');
    const r = rooms.find(x => x.id === room);
    $('worldsel').innerHTML = '<option value="0">— no world —</option>' +
        (books || []).map(b => `<option value="${b.id}"${r?.world_book_id === b.id ? ' selected' : ''}>${b.name}</option>`).join('');
}
async function setWorld(bookId) {
    await api('world/link', { room, book: Number(bookId) || null });
}

async function newRoom() {
    const name = $('newroom').value.trim();
    if (!name) return;
    $('newroom').value = '';
    const r = await api('rooms', { name });
    if (r.id) pick(r.id);
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
    const m = await get('me');
    me = m.handle || 'you';
    await loadRoom();
}

start();
