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
        ['Connection', '/connection.html'],
    ];
    const here = location.pathname === '/index.html' ? '/' : location.pathname;
    const nav = document.createElement('nav');
    nav.innerHTML = '<span class="brand">RP</span>' +
        NAV.map(([label, href]) =>
            `<a href="${href}"${href === here ? ' class="on"' : ''}>${label}</a>`).join('');

    const side = document.getElementById('sidebar');
    const content = document.getElementById('content') || document.body;
    const shell = document.createElement('div');
    shell.id = 'shell';
    if (side) shell.appendChild(side); else shell.classList.add('no-side');
    shell.appendChild(content);
    document.body.prepend(nav, shell);
})();
