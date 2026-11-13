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
        ['Mem settings', '/memsettings.html'],
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
        if (el && d.version) el.textContent = 'v' + d.version;
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
function mpOpenEditor(mode){
  const ed = document.getElementById('editor'); if (!ed) return;
  if (mode === 'inline') { ed.style.display = 'block'; ed.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
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
