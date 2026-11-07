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
        .map(m => `<div class="member">` +
            (m.kind === 'ai' && m.card_id
                ? `<span class="mname">${m.card_name}</span>` +
                  `<input type="range" class="talk" min="0" max="100" value="${m.talkativeness ?? 50}" title="talkativeness" oninput="this.nextElementSibling.textContent=this.value+'%'" onchange="setTalk(${m.card_id},this.value)">` +
                  `<span class="tv">${m.talkativeness ?? 50}%</span>` +
                  `<button class="fgen" title="Generate" onclick="genCard(${m.card_id},this)">▶</button>`
                : `<span>${m.card_name || m.handle || '?'} <small>${m.kind}</small></span>`) +
            `</div>`)
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
    renderToks();
    get('rooms').then(({ rooms }) => {
        const r = (rooms || []).find(x => x.id === room);
        if (r) { $('trigsel').value = r.ai_trigger || 'manual'; $('ctxmax').value = r.max_context || 0; }
    });
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
async function setTrig(mode) {
    await api('room/trigger', { room, mode });
}
async function setCtx(v) {
    await api('room/settings', { room, maxContext: Math.max(0, Number(v) || 0) });
}
async function setTalk(cardId, value) {
    await api('members/talkativeness', { room, cardId, value });
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
    renderToks();
}
async function genCard(cardId, btn) {
    btn.disabled = true;
    try {
        const r = await api('generate', { room, card: cardId });
        if (r.error) alert(r.error);
    } finally {
        btn.disabled = false;
    }
    renderToks();
}

async function renderToks() {
    const { stats } = await get('genstats?room=' + room);
    if (!stats) { $('toks').innerHTML = '<small>generate to see</small>'; return; }
    const total = stats.prompt_tokens ?? stats.est;
    $('toks').innerHTML =
        `<small style="color:#789">${stats.card} · ${stats.prompt_tokens ? 'actual' : 'estimated'}</small>` +
        `<div style="display:flex;justify-content:space-between;font-weight:600;font-size:.85em"><span>Prompt tokens</span><span>${total}</span></div>` +
        (stats.completion_tokens ? `<div style="display:flex;justify-content:space-between;font-size:.8em;color:#789"><span>Reply tokens</span><span>${stats.completion_tokens}</span></div>` : '') +
        Object.entries(stats.parts).filter(([, v]) => v).map(([k, v]) => {
            const href = {
                'World Info': '/world.html', 'Memories': '/memories.html',
                'Main Prompt': '/characters.html', 'Char Description': '/characters.html',
                'Char Personality': '/characters.html', 'Scenario': '/characters.html',
                'Chat Examples': '/characters.html', 'Other Characters': '/characters.html',
                'Post-History Instructions': '/characters.html',
            }[k];
            const lbl = href
                ? `<a href="${href}${AS ? '?as=' + AS : ''}" style="color:#9ab">${k}</a>` : `<span>${k}</span>`;
            return `<div style="display:flex;justify-content:space-between;font-size:.8em;color:#9ab"><span>${lbl}</span><span>${v}</span></div>`;
        }).join('');
}

async function start() {
    const m = await get('me');
    me = m.handle || 'you';
    await loadRoom();
}

start();
