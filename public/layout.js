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
        ['Connection', '/connection.html'],
    ];
    const here = location.pathname === '/index.html' ? '/' : location.pathname;
    const as = new URLSearchParams(location.search).get('as') || '';
    const nav = document.createElement('nav');
    nav.innerHTML = '<span class="brand">RP</span>' +
        NAV.map(([label, href]) =>
            `<a href="${href}${as ? '?as=' + as : ''}"${href === here ? ' class="on"' : ''}>${label}</a>`).join('') +
        '<span style="flex:1"></span><span id="test-users" style="display:flex;gap:6px;align-items:center"></span>';
    // Test mode: a button per user opens a fresh window as that perspective.
    fetch('/api/users').then(r => r.json()).then(({ users }) => {
        const box = nav.querySelector('#test-users');
        for (const u of users || []) {
            const b = document.createElement('a');
            b.href = `/?as=${u.handle}`;
            b.target = '_blank';
            b.textContent = u.handle;
            b.style.cssText = 'color:#9ab;text-decoration:none;padding:4px 10px;border-radius:5px;border:1px solid #333;font-size:.85em';
            box.appendChild(b);
        }
    }).catch(() => { });

    const side = document.getElementById('sidebar');
    const content = document.getElementById('content') || document.body;
    const shell = document.createElement('div');
    shell.id = 'shell';
    if (side) shell.appendChild(side); else shell.classList.add('no-side');
    shell.appendChild(content);
    document.body.prepend(nav, shell);
})();
