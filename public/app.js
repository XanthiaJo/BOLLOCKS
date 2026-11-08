let token = localStorage.mp_token || '';
let me = '';
let room = Number(localStorage.mp_room || 1);
let es = null;

const AS = '';
const $ = id => document.getElementById(id);
const api = (p, b, method = 'POST') => fetch(`/api/${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
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
    li.dataset.mid = m.id;
    li.className = 'mes' + (m.kind === 'ai' ? ' ai' : m.kind === 'sys' ? ' sys' : '');
    li.innerHTML = `<div class="who">${m.card_id ? `<img class="mav" src="/api/avatar?id=${m.card_id}" onerror="this.remove()">` : ''}<span class="n"></span></div><div class="body"><span class="t"></span></div>` +
        `<button class="delm" title="Delete" onclick="delMsg(${m.id},this)">✕</button>`;
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
            `<img class="mav" src="/api/avatar?id=${m.card_id || m.persona_id || 0}" onerror="this.style.display='none'">` +
            (m.kind === 'ai' && m.card_id
                ? `<span class="mname">${m.card_name}</span>` +
                  `<input type="range" class="talk" min="0" max="100" value="${m.talkativeness ?? 50}" title="talkativeness" oninput="this.nextElementSibling.textContent=this.value+'%'" onchange="setTalk(${m.card_id},this.value)">` +
                  `<span class="tv">${m.talkativeness ?? 50}%</span>` +
                  `<button class="fgen" title="Generate" onclick="genCard(${m.card_id},this)">▶</button>` +
                  `<button class="frem" title="Remove" onclick="remMember(${m.card_id},null,this)">✕</button>`
                : `<span>${m.card_name || m.persona_name || m.handle || '?'} <small>${m.kind}</small></span>` +
                  `<button class="frem" title="Remove" onclick="remMember(null,${m.user_id},this)">✕</button>`) +
            `</div>`)
        .join('') + `<div class="member" style="margin-top:6px"><select id="addpick" style="flex:1;font-size:.85em"></select>` +
            `<button class="fgen" title="Add" onclick="addMember()">+</button></div>`;
    renderLastMem(r.lastMem);
            `<button class="fgen" title="Add" onclick="addMember()">+</button></div>`;
    const cur = new Set((r.members || []).map(m => m.card_id ? 'c' + m.card_id : 'u' + m.user_id));
    const [{ users }, { cards }] = await Promise.all([get('users'), get('cards')]);
    $('addpick').innerHTML =
        (users || []).filter(x => !cur.has('u' + x.id)).map(x => `<option value="u${x.id}">${x.handle}</option>`).join('') +
        (cards || []).filter(x => !cur.has('c' + x.id)).map(x => `<option value="c${x.id}">${x.name} (ai)</option>`).join('') || '<option>— everyone\'s in —</option>';
    document.title = `RP · room ${room}`;
    if (es) es.close();
    es = new EventSource(`/api/stream?room=${room}&token=${token}`);
    es.onmessage = e => {
        const d = JSON.parse(e.data);
        if (d.type === 'message' && d.message.room_id === room) {
            addMsg(d.message);
            get(`lastmem?room=${room}`).then(renderLastMem);
        }
        if (d.type === 'delete') document.querySelector(`li[data-mid="${d.id}"]`)?.remove();
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
        .map(r => `<div class="room${r.id === room ? ' on' : ''}" onclick="pick(${r.id})"><span class="n">${r.name}</span>` +
            `<span class="rbtns"><a href="#" title="Rename" onclick="event.stopPropagation();renameRoom(${r.id});return false">✎</a>` +
            `<a href="#" title="Delete" onclick="event.stopPropagation();delRoom(${r.id});return false" style="color:#a55">✕</a></span></div>`)
        .join('');
}
function pick(id) { room = id; localStorage.mp_room = id; loadRoom(); }
async function renameRoom(id) {
    const n = prompt('Rename chat:', '');
    if (!n) return;
    await api('rooms/update', { id, name: n });
    loadRoom();
}
async function delRoom(id) {
    if (!confirm('Delete this chat and all its messages?')) return;
    await api('rooms/delete', { id });
    if (room === id) { room = 1; localStorage.mp_room = 1; }
    loadRoom();
}

async function renderWorld() {
    const { books, rooms } = await get('world/books');
    const r = rooms.find(x => x.id === room);
    $('worldsel').innerHTML = '<option value="0">— no world —</option>' +
        (books || []).map(b => `<option value="${b.id}"${r?.world_book_id === b.id ? ' selected' : ''}>${b.name}</option>`).join('');
}
async function setWorld(bookId) {
    await api('world/link', { room, book: Number(bookId) || null });
}
async function addMember() {
    const v = $('addpick').value;
    if (!v) return;
    const [kind, id] = [v[0], Number(v.slice(1))];
    await api('members', kind === 'c' ? { room, cardId: id, kind: 'ai' } : { room, userId: id });
    loadRoom();
}
async function remMember(cardId, userId, btn) {
    btn.disabled = true;
    await api('members/remove', { room, cardId, userId });
    loadRoom();
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

let persona = null;
async function say() {
    const text = $('in').value.trim();
    if (!text) return;
    $('in').value = '';
    await api('say', { room, name: persona?.name || me, cardId: persona?.id || null, text });
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

async function delMsg(id, btn) {
    if (!confirm('Delete this message?')) return;
    btn.disabled = true;
    await api('messages/delete', { id });
}
function renderLastMem(m) {
    $('lastmem').innerHTML = m ? `<div style="font-size:.8em;color:#9ab;line-height:1.4">${m.text}</div>` : '<div style="font-size:.8em;color:#555">none yet</div>';
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
                ? `<a href="${href}" style="color:#9ab">${k}</a>` : `<span>${k}</span>`;
            return `<div style="display:flex;justify-content:space-between;font-size:.8em;color:#9ab"><span>${lbl}</span><span>${v}</span></div>`;
        }).join('');
}

async function start() {
    const m = await get('me');
    me = m.handle || 'you';
    persona = m.persona || null;
    await loadRoom();
}

start();
