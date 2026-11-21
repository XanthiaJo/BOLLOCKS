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
        ['Stories', '/stories.html'],
        ['Memory profiles', '/memsettings.html'],
        ['Connection', '/connection.html'],
    ];
    const here = location.pathname === '/index.html' ? '/' : location.pathname;
    // The version badge lives at the bottom of the page's sidebar; pages
    // without one (profile) keep it under the nav brand as a fallback.
    const hasSidebar = !!(document.getElementById('sidebar') || document.getElementById('rsidebar'));
    const nav = document.createElement('nav');
    nav.innerHTML = '<span class="brand">🍒 B.O.L.L.O.C.K.S' + (hasSidebar ? '' : '<span class="ver" id="mpver"></span>') + '</span>' +
        '<div class="navlinks">' +
        NAV.map(([label, href]) =>
            `<a href="${href}"${href === here ? ' class="on"' : ''}>${label}</a>`).join('') +
        '<span id="mpadminlink"></span>' +
        '</div>' +
        '<div class="mp-navmenu" id="mpnavmenu">' +
        NAV.map(([label, href]) =>
            `<a href="${href}"${href === here ? ' class="on"' : ''}>${label}</a>`).join('') +
        '<span id="mpadminlinkm"></span>' +
        '</div>' +
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
    const MOB = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--mob')) || 700;
    const mob = () => window.innerWidth <= MOB;
    // Mobile sidebars are overlay drawers: dim scrim behind, one open at a
    // time, anchored just under the nav. closeDrawers() is the single exit.
    const scrim = document.createElement('div');
    scrim.className = 'mp-scrim';
    const closeDrawers = () => {
        for (const el of [side, rside]) el?.classList.remove('open');
        scrim.classList.remove('on');
    };
    scrim.onclick = closeDrawers;
    const mk = (el, side) => {
        const b = document.createElement('a');
        b.className = 'navtoggle';
        b.textContent = side === 'l' ? '💬' : '⚙';
        b.title = (side === 'l' ? 'Toggle chat list' : 'Toggle right panel');
        b.onclick = () => {
            if (!mob()) { el.classList.toggle('hide'); return; }
            const open = !el.classList.contains('open');
            closeDrawers(); // one open, never both
            if (open) {
                el.style.top = nav.offsetHeight + 'px';
                el.classList.add('open');
                scrim.classList.add('on');
            }
        };
        return b;
    };
    // Panel toggles sit with the trailing icons: 💬 before the user menu,
    // ⚙ after it — the left side stays ☰+brand on every page.
    if (side) nav.querySelector('.usermenu').before(mk(side, 'l'));
    if (rside) nav.appendChild(mk(rside, 'r'));
    // Hamburger for the site links — mobile only (CSS hides it on desktop).
    // Lives in the nav; the .mp-navmenu dropdown above renders them.
    const navmenu = nav.querySelector('#mpnavmenu');
    const menub = document.createElement('a');
    menub.className = 'navtoggle mp-menutgl';
    menub.textContent = '☰';
    menub.title = 'Menu';
    menub.onclick = e => {
        e.stopPropagation();
        const open = !navmenu.classList.contains('open');
        navmenu.classList.toggle('open', open);
        if (open) closeDrawers();
    };
    nav.prepend(menub);
    document.addEventListener('click', e => {
        if (!e.target.closest('.mp-navmenu,.mp-menutgl')) navmenu.classList.remove('open');
    });
    const shell = document.createElement('div');
    shell.id = 'shell';
    if (side) shell.appendChild(side);
    shell.appendChild(content);
    if (rside) shell.appendChild(rside);
    document.body.prepend(nav, shell);
    document.body.appendChild(scrim);
    // Picking a row (.room/.rprof, not its buttons) closes the drawer on mobile.
    for (const el of [side, rside]) el?.addEventListener('click', e => {
        if (mob() && e.target.closest('.room,.rprof') && !e.target.closest('.btns')) closeDrawers();
    });
    addEventListener('resize', () => { if (!mob()) { closeDrawers(); navmenu.classList.remove('open'); } });
    addEventListener('keydown', e => { if (e.key === 'Escape') { closeDrawers(); navmenu.classList.remove('open'); } });
    const ubtn = document.getElementById('mpuserbtn');
    const udrop = document.getElementById('mpuserdrop');
    ubtn.onclick = e => { e.stopPropagation(); udrop.classList.toggle('open'); };
    document.addEventListener('click', e => { if (!e.target.closest('.usermenu')) udrop.classList.remove('open'); });
    // Admin gets an extra nav link once we know who's logged in.
    fetch('/api/me', { headers: { Authorization: 'Bearer ' + (localStorage.mp_token || '') } })
        .then(r => r.ok ? r.json() : null).then(d => {
            if (d?.admin) for (const slot of ['mpadminlink', 'mpadminlinkm'])
                document.getElementById(slot)?.insertAdjacentHTML('beforebegin',
                    `<a href="/admin.html"${here === '/admin.html' ? ' class="on"' : ''}>Admin</a>`);
        }).catch(() => {});
    fetch('/api/version').then(r => r.json()).then(d => {
        mpVer = d.version || '';
        mpVerSha = d.sha || null;
        mpVerBadge();
    }).catch(() => {});
})();

/* Sidebar version badge + update check.
   The badge is pinned to the bottom of the page's sidebar (left #sidebar,
   else #rsidebar) and opens a popover that checks GitHub for updates on a
   chosen channel: stable = latest release, beta = latest vX.Y.Z-beta.N
   prerelease, nightly = latest dev commit (compared against the running
   build's git sha). Pages without a sidebar keep the badge in the nav. */
let mpVer = '', mpVerSha = null, mpUpd, mpUpdAnchor, mpUpdLast, mpAdmin = false;

function mpVerBadge() {
    const host = document.getElementById('sidebar') || document.getElementById('rsidebar');
    let el = document.getElementById('mpver');
    if (host && (!el || el.parentNode !== host)) {
        if (el) el.remove(); // nav fallback badge → move into the sidebar
        el = document.createElement('a');
        el.id = 'mpver'; el.className = 'mp-ver'; el.href = '#';
        el.onclick = e => { e.preventDefault(); mpUpdOpen(el); };
        host.appendChild(el);
    } else if (!host && !el) return;
    if (!mpVer) return;
    el.textContent = 'v' + mpVer;
    if (mpVerSha) {
        const s = document.createElement('span');
        s.textContent = mpVerSha;
        s.style.cssText = 'display:block;font-size:.85em';
        el.appendChild(s);
    }
}

const mpEsc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Anchor the popover to the badge (clamped to the viewport), flipping above
// it when the badge sits low. Re-run whenever the popover's content grows —
// the check result lands async, so the skeleton's height isn't final.
function mpUpdPlace() {
    if (!mpUpd || !mpUpdAnchor || !mpUpd.classList.contains('open')) return;
    mpUpd.style.top = mpUpd.style.left = '';
    const r = mpUpdAnchor.getBoundingClientRect();
    mpUpd.style.left = Math.max(8, Math.min(r.left, innerWidth - mpUpd.offsetWidth - 8)) + 'px';
    if (r.bottom + mpUpd.offsetHeight + 8 > innerHeight) mpUpd.style.top = Math.max(8, r.top - mpUpd.offsetHeight - 6) + 'px';
    else mpUpd.style.top = (r.bottom + 6) + 'px';
}

function mpUpdOpen(anchor) {
    if (!mpUpd) {
        mpUpd = document.createElement('div');
        mpUpd.className = 'mp-upd';
        document.body.appendChild(mpUpd);
        document.addEventListener('click', e => { if (!e.target.closest('.mp-upd,#mpver')) mpUpd.classList.remove('open'); });
        addEventListener('keydown', e => { if (e.key === 'Escape') mpUpd.classList.remove('open'); });
    }
    if (mpUpd.classList.contains('open')) return mpUpd.classList.remove('open');
    mpUpdAnchor = anchor;
    const saved = localStorage.mp_updchan || 'stable';
    mpUpd.innerHTML = '<div class="updh">Check for updates</div>' +
        '<div class="updchans">' +
        ['stable', 'beta', 'nightly'].map(c =>
            `<button${c === saved ? ' class="on"' : ''} onclick="mpUpdCheck('${c}')">${c[0].toUpperCase() + c.slice(1)}</button>`).join('') +
        '</div><div class="updres" id="mpupdres"></div>';
    mpUpd.classList.add('open');
    mpUpdPlace();
    mpUpdCheck(saved);
    // Am I admin? Decides whether the pull/update action is offered.
    fetch('/api/me', { headers: { Authorization: 'Bearer ' + (localStorage.mp_token || '') } })
        .then(r => r.ok ? r.json() : null).then(d => {
            if (d?.admin && mpUpdLast) { mpAdmin = true; mpUpdRender(mpUpdLast); }
        }).catch(() => {});
}

function mpUpdRender(d) {
    const res = document.getElementById('mpupdres');
    if (!res) return;
    if (d.error) { res.textContent = d.error; return; }
    const pull = ch => mpAdmin
        ? `<br><button class="act" onclick="mpUpdPull('${ch}')">Pull &amp; update</button>` : '';
    if (d.channel === 'nightly') {
        if (!d.latest) { res.textContent = 'No commits found on dev.'; return; }
        res.innerHTML = `Dev tip: <b>${mpEsc(d.latest.sha)}</b> — ${mpEsc(d.latest.message)}<br>` +
            `<a href="${mpEsc(d.latest.url)}" target="_blank" rel="noopener">View commit</a>` +
            (d.update === true ? '<br><b>New commit available.</b>'
                : d.update === null ? "<br>(running build has no git sha — can't compare)" : '<br>Up to date.') +
            // Nightly can always be synced by an admin (null = sha unknown).
            (d.update !== false ? pull('nightly') : '');
    } else if (d.latest) {
        res.innerHTML = (d.update
            ? `New release available: <b>${mpEsc(d.latest.tag)}</b><br><a href="${mpEsc(d.latest.url)}" target="_blank" rel="noopener">View release</a>`
            : `Up to date — latest ${d.channel} is <b>${mpEsc(d.latest.tag)}</b>`) + (d.update ? pull(d.channel) : '');
    } else {
        res.textContent = `No ${d.channel} releases yet.`;
    }
    mpUpdPlace();
}

function mpUpdCheck(ch) {
    localStorage.mp_updchan = ch;
    for (const b of mpUpd.querySelectorAll('.updchans button'))
        b.classList.toggle('on', b.getAttribute('onclick') === `mpUpdCheck('${ch}')`);
    const res = document.getElementById('mpupdres');
    if (!res) return;
    res.textContent = 'Checking…';
    mpUpdPlace();
    fetch('/api/update?channel=' + ch, { headers: { Authorization: 'Bearer ' + (localStorage.mp_token || '') } })
        .then(r => r.status === 401 ? (location = '/login.html') : r.json())
        .then(d => { if (d) { mpUpdLast = d; mpUpdRender(d); } })
        .catch(() => { res.textContent = 'Update check failed.'; mpUpdPlace(); });
}

// Admin action: fast-forward the checkout to the channel's branch and let the
// server restart itself; poll /api/version until the new build answers.
function mpUpdPull(ch) {
    const res = document.getElementById('mpupdres');
    if (!res) return;
    res.textContent = 'Pulling…';
    fetch('/api/update/pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (localStorage.mp_token || '') },
        body: JSON.stringify({ channel: ch }),
    })
        .then(r => r.status === 401 ? (location = '/login.html') : r.json())
        .then(d => {
            if (!d) return;
            if (d.error) { res.textContent = d.error; mpUpdPlace(); return; }
            res.innerHTML = `Updated to <b>${mpEsc(d.sha)}</b> (${mpEsc(d.branch)}) — restarting…`;
            mpUpdPlace();
            const t0 = Date.now();
            const iv = setInterval(() => {
                fetch('/api/version').then(r => r.json()).then(v => {
                    if ((v.sha && v.sha !== mpVerSha) || (!v.sha && Date.now() - t0 > 4000)) {
                        clearInterval(iv);
                        location.reload();
                    } else if (Date.now() - t0 > 20000) {
                        clearInterval(iv);
                        res.textContent = 'Restart pending — reload the page in a moment.';
                    }
                }).catch(() => {});
            }, 1200);
        })
        .catch(() => { res.textContent = 'Update failed.'; });
}

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
    mpVerBadge(); // innerHTML wipe removes the version badge — pin it back
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

/* Accordion — wraps each <h4> inside `panel` (plus the siblings up to the
   next h4) into an .acc collapsible section; open sections persist under
   `key` in localStorage, or default to `openDefault` titles on first use.
   setupAcc(document.getElementById('profpanel'), 'mp_mem_acc') */
function setupAcc(panel, key, openDefault = []) {
    if (!panel) return;
    const escAcc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const stored = localStorage[key];
    let openSet = null; try { openSet = stored == null ? null : new Set(JSON.parse(stored)); } catch { }
    if (!openSet) openSet = new Set(openDefault);
    const saveAcc = () => { localStorage[key] = JSON.stringify([...panel.querySelectorAll('.acc-h.open')].map(h => h.dataset.acc)); };
    for (const h of [...panel.querySelectorAll('h4')]) {
        const wrap = document.createElement('div'); wrap.className = 'acc';
        const header = document.createElement('div'); header.className = 'acc-h';
        header.dataset.acc = h.textContent.trim();
        const title = document.createElement('div'); title.className = 'acc-t';
        title.innerHTML = escAcc(h.textContent);
        const arrow = document.createElement('span'); arrow.className = 'arrow'; arrow.textContent = '▸';
        header.append(title, arrow);
        const body = document.createElement('div'); body.className = 'acc-b';
        const toMove = []; let node = h.nextSibling;
        while (node && !(node.nodeType === 1 && node.tagName === 'H4')) { toMove.push(node); node = node.nextSibling; }
        h.parentNode.insertBefore(wrap, h);
        wrap.appendChild(header); wrap.appendChild(body);
        for (const n of toMove) body.appendChild(n);
        // An intro hint right after the h4 belongs on the header line.
        if (body.firstElementChild?.classList.contains('hint')) title.append(body.firstElementChild);
        // Sections where every control is disabled are placeholders — say so.
        if (!title.querySelector('.hint') && !body.querySelector('input:not([disabled]),select:not([disabled]),textarea:not([disabled])')) {
            const note = document.createElement('span'); note.className = 'hint';
            note.textContent = 'Not implemented yet — these are placeholders for planned features.';
            title.append(note);
        }
        h.remove();
        if (openSet.has(header.dataset.acc)) { header.classList.add('open'); body.classList.add('open'); }
        header.onclick = () => { header.classList.toggle('open'); body.classList.toggle('open'); saveAcc(); };
    }
}

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
