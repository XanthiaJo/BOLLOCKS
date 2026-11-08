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
        ['Connection', '/connection.html'],
    ];
    const here = location.pathname === '/index.html' ? '/' : location.pathname;
    const nav = document.createElement('nav');
    nav.innerHTML = '<span class="brand">RP</span>' +
        NAV.map(([label, href]) =>
            `<a href="${href}"${href === here ? ' class="on"' : ''}>${label}</a>`).join('') +
        '<span style="flex:1"></span>' +
        `<a href="/login.html" onclick="localStorage.removeItem('mp_token')" style="color:#789" title="Log out">⏻</a>`;

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
function mpOpenEditor(){
  if (!document.getElementById('mpveil')) {
    const v = document.createElement('div');
    v.id = 'mpveil'; v.className = 'mp-veil';
    v.addEventListener('click', e => { if (e.target === v) mpCloseEditor(); });
    document.body.appendChild(v);
    v.appendChild(document.getElementById('editor'));
  }
}
function mpCloseEditor(){ document.getElementById('mpveil')?.remove(); }
