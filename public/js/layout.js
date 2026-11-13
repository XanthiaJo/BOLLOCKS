/* Shared shell: top nav + left sidebar + content.
   Page convention:
     <link rel="stylesheet" href="layout.css">
     <aside id="sidebar">…optional…</aside>
     <div id="content">…main…</div>
     <script src="layout.js"></script>
*/
(() => {
    const NAV = [
        ['Chat', '/'],
        ['Characters', '/characters.html'],
        ['World', '/world.html'],
        ['Memories', '/memories.html'],
        ['Smart memory', '/memsettings.html'],
        ['Connection', '/connection.html'],
    ];
    const here = location.pathname === '/index.html' ? '/' : location.pathname;
    const nav = document.createElement('nav');
    nav.innerHTML = '<span class="brand">🍒 B.O.L.L.O.C.K.S<span class="ver" id="mpver"></span></span>' +
        NAV.map(([label, href]) =>
            `<a href="${href}"${href === here ? ' class="on"' : ''}>${label}</a>`).join('') +
        '<span style="flex:1"></span>' +
        '<span class="usermenu">' +
        '<a id="mpuserbtn" class="navtoggle" title="Account">👤</a>' +
        '<div class="userdrop" id="mpuserdrop">' +
        '<a href="/profile.html">Profile Settings</a><hr>' +
        `<a href="/api/logout" onclick="localStorage.removeItem('mp_token')">Logout</a>` +
        '</div></span>';

    const side = document.getElementById('sidebar');
    const rside = document.getElementById('rsidebar');
    const content = document.getElementById('content') || document.body;
    // Collapse toggles in the nav for each sidebar that exists.
    const mob = () => window.innerWidth <= 700;
    const mk = (el, side) => {
        const b = document.createElement('a');
        b.className = 'navtoggle';
        b.textContent = side === 'l' ? '☰' : '⚙';
        b.title = (side === 'l' ? 'Toggle left panel' : 'Toggle right panel');
        b.onclick = () => el.classList.toggle(mob() ? 'open' : 'hide');
        return b;
    };
    if (side) nav.prepend(mk(side, 'l'));
    if (rside) nav.appendChild(mk(rside, 'r'));
    const shell = document.createElement('div');
    shell.id = 'shell';
    if (side) shell.appendChild(side);
    shell.appendChild(content);
    if (rside) shell.appendChild(rside);
    document.body.prepend(nav, shell);
    const ubtn = document.getElementById('mpuserbtn');
    const udrop = document.getElementById('mpuserdrop');
    ubtn.onclick = e => { e.stopPropagation(); udrop.classList.toggle('open'); };
    document.addEventListener('click', e => { if (!e.target.closest('.usermenu')) udrop.classList.remove('open'); });
    fetch('/api/version').then(r => r.json()).then(d => {
        const el = document.getElementById('mpver');
        if (!el || !d.version) return;
        el.textContent = 'v' + d.version;
        if (d.sha) {
            const s = document.createElement('span');
            s.textContent = d.sha;
            s.style.cssText = 'display:block;font-size:.85em';
            el.appendChild(s);
        }
    }).catch(() => {});
})();

// Right-sidebar profile quick-activate (used by connection page's rail).
function activateProf(id) {
    fetch('/api/profiles/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
    }).then(() => document.querySelectorAll('.rprof').forEach(el =>
        el.classList.toggle('on', el.getAttribute('onclick') === `activateProf(${id})`)));
}

/* Centralized editor: pages keep their #editor markup; this wraps it in a
   modal veil so editing always surfaces as a card — one place to restyle. */
// Scroll an opened editor into view — including a preceding .cvhead title
// panel when it shares the parent, so page titles don't scroll away.
function mpScrollTo(el){
  const p = el.previousElementSibling;
  (p && p.classList.contains('cvhead') ? p : el).scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function mpOpenEditor(mode){
  const ed = document.getElementById('editor'); if (!ed) return;
  if (mode === 'inline') { ed.style.display = 'block'; mpScrollTo(ed); return; }
  if (!document.getElementById('mpveil')) {
    if (!ed._home) { ed._home = ed.parentNode; ed._next = ed.nextSibling; }
    const v = document.createElement('div');
    v.id = 'mpveil'; v.className = 'mp-veil';
    v.addEventListener('click', e => { if (e.target === v) mpCloseEditor(); });
    document.body.appendChild(v);
    v.appendChild(ed);
  }
}
function mpCloseEditor(){
  const v = document.getElementById('mpveil'); if (!v) return;
  const ed = document.getElementById('editor');
  if (ed && ed._home) { ed._home.insertBefore(ed, ed._next || null); }
  v.remove();
}

// Transient "saved" toast — pages call this after a successful write so the
// form can stay open instead of vanishing.
function mpFlashSaved(msg = 'Saved') {
    let t = document.getElementById('mpsaved');
    if (!t) {
        t = document.createElement('div');
        t.id = 'mpsaved'; t.className = 'mp-saved';
        document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._t);
    t._t = setTimeout(() => t.classList.remove('show'), 1600);
}

/* Sidebar picker row — the single place this markup is built. All settings
   pages render .rprof rows through here so shape changes happen once.
     name/meta/img/btns are raw HTML (escape dynamic text at the call site);
     onclick is a JS call string; sel = the one selected state (accent). */
function rprofRow({ name, meta = '', img = '', sel = false, onclick = '', btns = '' }) {
    return `<div class="rprof${sel ? ' sel' : ''}"${onclick ? ` onclick="${onclick}"` : ''}>${img}` +
        `<div class="txt"><div class="n">${name}</div>${meta ? `<div class="m">${meta}</div>` : ''}</div>` +
        `${btns ? `<div class="btns" onclick="event.stopPropagation()">${btns}</div>` : ''}</div>`;
}

/* Sidebar skeleton — the single place #rsidebar's structure exists. Pages
   declare an empty <aside id="rsidebar"></aside> and call initSidebar({...});
   identical layout/size everywhere, only the data differs.
     tabs:     [{id?,label,onclick?,on?}]  REQUIRED — every sidebar has the
                                    kind bar at top; one static .on tab for
                                    single-kind pages. onclick optional.
     sections: [{id,title?,wrap?}]   h3 title + <div id> list; wrap wraps
                                    title+list in <div id=wrap> (for toggling)
     buttons:  [{label,onclick,cls?}] full-width actions under the list
     footer:   html string for the trailing <small> caption */
function initSidebar({ tabs = [], sections = [], buttons = [], footer = '' } = {}) {
    const sb = document.getElementById('rsidebar'); if (!sb) return;
    if (!tabs.length) console.warn('[layout] initSidebar: every sidebar must show a tab bar');
    sb.innerHTML =
        `<div class="tabs">${tabs.map(t => `<button class="tab${t.on ? ' on' : ''}"${t.id ? ` id="${t.id}"` : ''}${t.onclick ? ` onclick="${t.onclick}"` : ''}>${t.label}</button>`).join('')}</div>` +
        sections.map(s => `${s.wrap ? `<div id="${s.wrap}">` : ''}${s.title ? `<h3>${s.title}</h3>` : ''}<div id="${s.id}"></div>${s.wrap ? '</div>' : ''}`).join('') +
        buttons.map(b => `<button${b.id ? ` id="${b.id}"` : ''} class="${b.cls || 'act'}" onclick="${b.onclick}">${b.label}</button>`).join('') +
        (footer ? `<small>${footer}</small>` : '');
}

/* Editor form header — every editor's first child is
   <div class="edhead" data-save="fnName" data-cancel="fnName"><h3 id="…">…</h3></div>
   and this injects the shared [Cancel][Save] pair wired to those globals.
   Call initEdHeads(root) again after adding form markup dynamically.
   Cancel convention: editing → reset fields to the loaded item; new → discard. */
function initEdHeads(root = document) {
    root.querySelectorAll('.edhead[data-save]:not([data-wired])').forEach(h => {
        h.dataset.wired = '1';
        const bar = document.createElement('span'); bar.className = 'edbtns';
        for (const [fn, label, cls] of [[h.dataset.cancel, 'Cancel', 'sec'], [h.dataset.save, 'Save', 'act']]) {
            const b = document.createElement('button'); b.textContent = label; if (cls) b.className = cls;
            b.onclick = () => window[fn]?.(); bar.appendChild(b);
        }
        h.appendChild(bar);
    });
}
initEdHeads();

/* In-place edit helpers — preserve unsaved input across a list re-render:
   const d = draftFields(['a','b']); list.innerHTML = …; fillFields(d);
   Keyed by element id; checkboxes round-trip via .checked. */
function draftFields(ids) {
    const d = {};
    for (const i of ids) { const el = document.getElementById(i); if (el) d[i] = el.type === 'checkbox' ? el.checked : el.value; }
    return Object.keys(d).length ? d : null;
}
function fillFields(d) {
    for (const [i, v] of Object.entries(d || {})) { const el = document.getElementById(i); if (!el) continue; if (el.type === 'checkbox') el.checked = !!v; else el.value = v; }
}
