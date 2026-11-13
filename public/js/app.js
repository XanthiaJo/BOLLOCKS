let token = localStorage.mp_token || '';
let me = '';
let room = Number(localStorage.mp_room || 1);
let es = null;
let roomIsOwner = false;
let allUsers = [], allCards = [], memberCur = new Set();

const AS = '';
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const api = (p, b, method = 'POST') => fetch(`/api/${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    ...(method === 'POST' ? { body: JSON.stringify(b || {}) } : {}),
}).then(r => r.status === 401 ? location = '/login.html' : r.json());
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
    li.innerHTML = `<div class="who">${m.cards_id_fk ? `<img class="mav" src="/api/avatar?id=${m.cards_id_fk}" onerror="this.remove()">` : ''}<span class="n"></span></div><div class="body"><span class="t"></span></div>` +
        `<button class="delm" title="Delete" onclick="delMsg(${m.id},this)">✕</button>`;
    li.querySelector('.n').textContent = m.name;
    li.querySelector('.t').innerHTML = md(m.text);
    $('msgs').append(li);
    $('msgs').scrollTop = 1e9;
}

async function loadRoom() {
    // Self-heal a stale room id (e.g. room 1 when only room 2 exists).
    try {
        const { rooms: rr } = await get('rooms');
        if (Array.isArray(rr) && rr.length && !rr.find(x => x.id === room)) {
            room = rr[0].id;
            localStorage.mp_room = room;
        }
    } catch { }
    const r = await get(`room?id=${room}`);
    $('msgs').innerHTML = '';
    (r.messages || []).forEach(addMsg);
    $('members').innerHTML = (r.members || [])
        .map(m => `<div class="member">` +
            `<img class="mav" src="/api/avatar?id=${m.cards_id_fk || m.persona_id || 0}" onerror="this.style.display='none'">` +
            (m.kind === 'ai' && m.cards_id_fk
                ? `<span class="mname">${m.card_name}</span>` +
                  `<input type="range" class="talk" data-mine="${m.mine ? 1 : 0}" min="0" max="100" value="${m.talkativeness ?? 50}" title="talkativeness" oninput="this.nextElementSibling.textContent=this.value+'%'" onchange="setTalk(${m.cards_id_fk},this.value)">` +
                  `<span class="tv">${m.talkativeness ?? 50}%</span>` +
                  `<button class="fgen" title="Generate" onclick="genCard(${m.cards_id_fk},this)">▶</button>` +
                  `<button class="frem" title="Remove" onclick="remMember(${m.cards_id_fk},null,this)">✕</button>`
                : `<span>${m.card_name || m.persona_name || m.handle || '?'} <small>${m.kind}</small></span>` +
                  `<button class="frem" title="Remove" onclick="remMember(null,${m.users_id_fk},this)">✕</button>`) +
            `</div>`)
        .join('') + `<div class="member" style="margin-top:6px"><select id="addpick" style="flex:1;font-size:.85em"></select>` +
            `<button class="fgen" title="Add" onclick="addMember()">+</button></div>`;
    renderLastMem(r.lastMem);
    memberCur = new Set((r.members || []).flatMap(m => [m.cards_id_fk ? 'c' + m.cards_id_fk : null, m.users_id_fk ? 'u' + m.users_id_fk : null]).filter(Boolean));
    const [{ users }, { cards }] = await Promise.all([get('users'), get('cards')]);
    allUsers = users || []; allCards = cards || [];
    fillAddPick();
    document.title = `BOLLOCKS · room ${room}`;
    if (es) es.close();
    es = new EventSource(`/api/stream?room=${room}&token=${token}`);
    es.onmessage = e => {
        const d = JSON.parse(e.data);
        if (d.type === 'message' && d.message.rooms_id_fk === room) {
            addMsg(d.message);
            get(`lastmem?room=${room}`).then(renderLastMem);
            renderToks();
        }
        if (d.type === 'delete') document.querySelector(`li[data-mid="${d.id}"]`)?.remove();
        if (d.type === 'mem') mpFlashSaved(d.phase === 'done' ? (d.count ? `${d.count} new memories` : 'Memories updated') : 'Extracting memories…');
    };
    renderRooms();
    renderWorld();
    renderToks();
    get('rooms').then(({ rooms }) => {
        const r = (rooms || []).find(x => x.id === room);
        document.title = `BOLLOCKS · ${r?.name || `room ${room}`}`;
        $('chatname').textContent = r?.name || `room ${room}`;
        roomIsOwner = !!r?.is_owner;
        applyOwnerUI();
        if (r) { $('trigsel').value = r.ai_trigger || 'manual'; $('ctxmax').value = r.max_context || 0; renderMProf(r); }
        $('chat').style.setProperty('--bg', r?.bg ? `url(/api/roombg?id=${room})` : 'none');
    });
}

async function renderRooms() {
    const { rooms } = await get('rooms');
    $('rooms').innerHTML = (rooms || [])
        .map(r => `<div class="room${r.id === room ? ' on' : ''}" onclick="pick(${r.id})"><span style="font-size:.85em">${(r.members||0)>2?'👥':'👤'}</span><span class="n">${r.name}</span>` +
            `${(r.members||0)>2?`<span style="font-size:.72em;color:var(--dim)">${r.members}</span>`:''}` +
            (r.is_owner ? `<span class="rbtns"><a href="#" title="Rename" onclick="event.stopPropagation();renameRoom(${r.id});return false">✎</a>` +
            `<a href="#" title="Delete" onclick="event.stopPropagation();delRoom(${r.id});return false" style="color:var(--err)">✕</a></span>` : '') + `</div>`)
        .join('');
}
function applyOwnerUI() {
    for (const id of ['trigsel', 'worldsel', 'mprofsel', 'ctxmax', 'bgfile']) {
        const el = $(id); if (el) el.disabled = !roomIsOwner;
    }
    document.querySelectorAll('#members .talk').forEach(el => el.disabled = !(roomIsOwner || el.dataset.mine === '1'));
    fillAddPick();
}
function fillAddPick() {
    const sel = $('addpick'); if (!sel) return;
    // Non-owners may only seat their own characters; seating other users is owner-only.
    const users = roomIsOwner ? allUsers : [];
    const cards = roomIsOwner ? allCards : allCards.filter(c => c.owner === me);
    sel.innerHTML =
        users.filter(x => !memberCur.has('u' + x.id)).map(x => `<option value="u${x.id}">${x.handle}</option>`).join('') +
        cards.filter(x => !memberCur.has('c' + x.id)).map(x => `<option value="c${x.id}">${x.name} (ai)</option>`).join('') || '<option>— everyone\'s in —</option>';
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
        (books || []).map(b => `<option value="${b.id}"${r?.world_books_id_fk === b.id ? ' selected' : ''}>${b.name}</option>`).join('');
}
async function setWorld(bookId) {
    await api('world/link', { room, book: Number(bookId) || null });
}
async function addMember() {
    const v = $('addpick').value;
    if (!v) return;
    const [kind, id] = [v[0], Number(v.slice(1))];
    const r = await api('members', kind === 'c' ? { room, cardId: id } : { room, userId: id });
    if (r.error) alert(r.error);
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
async function renderMProf(r) {
    const sel = $('mprofsel'); if (!sel) return;
    // Owners pick from their own profiles; members only see the followed name.
    if (roomIsOwner) {
        const { profiles } = await get('memprofiles');
        sel.innerHTML = '<option value="0">Disabled</option>' +
            (profiles || []).map(p => `<option value="${p.mem_profiles_id_pk}">${esc(p.name)}</option>`).join('');
        sel.value = String(r?.mem_profiles_id_fk || 0);
    } else {
        sel.innerHTML = `<option>${esc(r?.mem_profile_name || 'Disabled')}</option>`;
    }
}
async function setMProf(v) {
    await api('room/memsettings', { room, memProfile: Number(v) || 0 });
}
async function uploadBg(inp) {
    const f = inp.files?.[0]; if (!f) return;
    const b64 = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result.split(',')[1]); fr.readAsDataURL(f); });
    await api('room/background', { room, png_b64: b64 });
    loadRoom();
}
async function clearBg() { await api('room/background/remove', { room }); loadRoom(); }
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
    await api('say', { room, cardId: persona?.id || null, text });
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
    $('lastmem').innerHTML = m ? `<div style="font-size:.8em;color:var(--muted);line-height:1.4">${m.text}</div>` : '<div style="font-size:.8em;color:var(--neutral)">none yet</div>';
}
let lastStats = null;
const PAGE_LINKS = { 'World Info': '/world.html', 'Memories': '/memories.html' };
function showJson(title, obj) {
    let v = document.getElementById('partview');
    if (!v) {
        v = document.createElement('div');
        v.id = 'partview'; v.className = 'mp-veil';
        v.onclick = e => { if (e.target === v) v.remove(); };
        document.body.appendChild(v);
    }
    v.innerHTML = `<div class="card" style="width:min(720px,94vw);max-height:82vh;overflow-y:auto;background:var(--panel);padding:16px">
        <h3 style="margin:0 0 10px">${title}</h3>
        <pre style="white-space:pre-wrap;font-size:.8em;color:var(--pre);margin:0 0 14px">${String(obj ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
        <button onclick="document.getElementById('partview').remove()">Close</button></div>`;
}
function showRequest() { showJson('Request JSON', JSON.stringify(lastStats?.request, null, 2)); }
function showPart(k) {
    const txt = (lastStats?.texts || {})[k];
    let v = document.getElementById('partview');
    if (!v) {
        v = document.createElement('div');
        v.id = 'partview'; v.className = 'mp-veil';
        v.onclick = e => { if (e.target === v) v.remove(); };
        document.body.appendChild(v);
    }
    const esc = String(txt ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    v.innerHTML = `<div class="card" style="width:min(720px,94vw);max-height:82vh;overflow-y:auto;background:var(--panel);padding:16px">
        <h3 style="margin:0 0 10px">${k}</h3>
        <pre style="white-space:pre-wrap;font-size:.85em;color:var(--pre);margin:0 0 14px">${esc || '(empty)'}</pre>
        <button onclick="document.getElementById('partview').remove()">Close</button></div>`;
}
async function renderToks() {
    const { stats } = await get('genstats?room=' + room);
    lastStats = stats;
    if (!stats) { $('toks').innerHTML = '<small>generate to see</small>'; return; }
    const total = stats.prompt_tokens ?? stats.est;
    // The API only reports the prompt total — scale the per-section
    // estimates so they sum to it (≈ attribution, not exact counts).
    const entries = Object.entries(stats.parts).filter(([, v]) => v);
    const estSum = entries.filter(([k]) => !k.startsWith('(')).reduce((a, [, v]) => a + v, 0);
    const scale = stats.prompt_tokens && estSum ? stats.prompt_tokens / estSum : 1;
    $('toks').innerHTML =
        `<small style="color:var(--dim)">${stats.card} · <a href="#" onclick="showRequest();return false" style="color:var(--muted)" title="View full request JSON">${stats.prompt_tokens ? 'actual' : 'estimated'}</a></small>` +
        `<div style="display:flex;justify-content:space-between;font-weight:600;font-size:.85em"><span>Prompt tokens</span><span>${total}</span></div>` +
        (stats.completion_tokens ? `<div style="display:flex;justify-content:space-between;font-size:.8em;color:var(--dim)"><span>Reply tokens</span><span>${stats.completion_tokens}</span></div>` : '') +
        (scale !== 1 ? `<small style="color:var(--faint)">sections ≈ scaled to actual total</small>` : '') +
        entries.map(([k, v]) => {
            const shown = k.startsWith('(') ? v : Math.round(v * scale);
            const href = PAGE_LINKS[k];
            const hasText = k in (lastStats?.texts || {});
            const lbl = href
                ? `<a href="${href}" style="color:var(--muted)">${k}</a>`
                : hasText
                    ? `<a href="#" onclick="showPart('${k}');return false" style="color:var(--muted)">${k}</a>`
                    : `<span>${k}</span>`;
            return `<div style="display:flex;justify-content:space-between;font-size:.8em;color:var(--muted)" title="est ${v}"><span>${lbl}</span><span>${shown}</span></div>`;
        }).join('');
}

async function start() {
    const m = await get('me');
    me = m.handle || 'you';
    persona = m.persona || null;
    const { rooms } = await get('rooms');
    if (rooms && rooms.length && !rooms.some(r => r.id === room)) {
        room = rooms[0].id;
        localStorage.mp_room = room;
    }
    await loadRoom();
}

start();
