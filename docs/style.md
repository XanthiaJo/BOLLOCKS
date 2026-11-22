# Style & frontend conventions

How the UI is built: one shared stylesheet, one shared helper script, and a
small vocabulary of components reused on every page. **DRY is the rule** —
before adding a class or a button pattern, check this doc: it almost
certainly already exists.

- All styles live in `public/css/layout.css`. There is no per-page CSS file.
  A page may override a rule in its own `<style>` block when it genuinely
  diverges (e.g. `characters.html` redefines `.card`'s grid columns).
- All shared JS helpers live in `public/js/layout.js`, injected into every
  page. Pages talk to them via globals — no imports, no modules.
- Theme color = CSS custom properties. **Never hardcode hex** in markup or
  page CSS — use the tokens below.

## Design tokens (`:root`, layout.css)

| Group | Vars | Use |
|---|---|---|
| Surfaces | `--bg`, `--bg-deep`, `--surface`, `--surface2`, `--surface3`, `--panel`, `--panel2`, `--input`, `--input2` | `--surface` cards/nav/sidebars, `--surface2` hovers, `--surface3` accordion bodies, `--panel` editors/panels/`.cvhead`, `--input` accordion headers + form fields |
| Lines | `--line`, `--line2`, `--border`, `--edge`, `--track` | `--line`/`--line2` dividers & row borders, `--border` input borders, `--edge` = `var(--accent)` selected/panel borders |
| Text | `--text`, `--white`, `--muted`, `--dim`, `--faint`, `--desc`, `--pre`, `--it` | `--muted` links/secondary, `--dim` labels, `--faint` meta rows, `--desc` descriptions |
| Accent | `--accent`, `--accent-bg`, `--ok`, `--ok-deep` | selection states, primary actions, `.badge` |
| Memory types | `--mtag`, `--mev`, `--mrel(--bg)`, `--mpref(--bg)` | `.mtag` type-tag colors: `.mfact` plain, `.mevent`, `.mrelationship`, `.mpreference` |
| Layout | `--mob` (700) | mobile breakpoint px — canonical; JS reads it via `mob()`, `@media` literals duplicate it. Keep both in sync |

`login.html` is self-contained and keeps its own `:root` copy of the
palette — update both if colors change.

## Page skeleton

Every page = `js/layout.js` shell + page markup:

- Top nav injected by layout.js (links, version badge `.mp-ver`, user menu).
- Sidebar: `<aside id="rsidebar"></aside>` + `initSidebar({tabs, sections, buttons, footer})`. Tabs are `.tab` buttons (Manual/Smart etc.); sections get an `<h3>` + a list; picker rows are built by `rprofRow()` — never hand-write row HTML.
- Content: `.cvhead` (title + action buttons) → `#list` of `.card` rows → optional `+ New X` `.panel` with `.edhead`.

## Component anatomy

### `.card` — the row unit

```css
.card{display:grid;grid-template-columns:1fr 92px;gap:10px}
```

- Col 1: content cell — `.comment`/`.name` (title), `.keys` (tag line),
  `.meta` (`#id · date · scope`, `--faint`), `.desc`
- Col 2: `.btns` — `flex-direction:column` stack of narrow action buttons
  (Edit / →manual / Delete). Buttons shrink-to-fit, stacked top→bottom
- **Full-width content below both columns** (confirm rows, pickers,
  expanded detail): add a third grid child with `grid-column:1/-1`. Do NOT
  try to fit multi-button rows inside `.btns` — the 92px column overflows
- `.card.editing` = in-place edit form (`display:block`, accent border)
- `.card.off` = disabled look (`opacity:.5`)

### Buttons & the global margin trap

`input,textarea,select,button` get `margin:3px 0` globally. Inside `.btns`
that's the vertical rhythm; in ad-hoc flex rows it misaligns siblings —
strip it with `margin:0` on those buttons. `.cvhead button` already does.

`.del` (red) = destructive action. Confirm destructive actions **inline**,
not `confirm()`: the established pattern is a toggle-render — click sets a
`*PickId` global, `renderList()` re-renders, the row swaps to confirm
options (see `delPickId`/`permPickId`/`editId`/`histId` in
`public/js/memories.js`).

### Badges & tags

- `.mtag` — small tag chip, `text-transform:capitalize` (stored values
  stay lowercase; capitalize display-only). Type color variants:
  `.mtag.m<type>`. Used for memory type, `canon`, `superseded`, status
- `.badge` — green pill = "in use / active" marker on `.rprof` rows
- `.hint` — small italic dim line (counts, captions). In accordion
  headers, counts live in a `.hint` span so the `<h4>` text (the
  persistence key) stays stable

### `.rprof` — sidebar picker rows

`rprofRow({name, meta, img, sel, onclick, btns})` builds the row.
`sel:true` = the accent *selected* state (the one being viewed); "in
use/active" is a `.badge`. Don't invent per-page highlight classes.

### `.acc` — accordions

`setupAcc(panelEl, storageKey, openDefaultTitles)` wraps every `<h4>` +
following siblings into `.acc` sections (`.acc-h` header, `.arrow`,
`.acc-b` body). Open state persists in `localStorage[storageKey]` keyed
by **h4 text** — keep dynamic content out of the h4. `openDefaultTitles`
= open on first visit; omitted = all collapsed.

### `.edhead` — editor headers

`<div class="edhead" data-save="fn" data-cancel="fn"><h3>` — layout.js
injects `[Cancel][Save]` wired to the named globals; call
`initEdHeads(root)` after injecting markup dynamically. Saves are
explicit — never `onchange` autosave.

### `.panel` / `.settings`

`.panel` = bordered panel for forms/editor blocks. `.panel.settings`
holds settings rows: `.row` (grid `1fr auto` — `.lbl` + `.hint` left,
control right), `.lbl`, `h4` section captions, `.cbrow` checkbox rows.

## JS helpers (layout.js globals)

| Helper | Use |
|---|---|
| `initSidebar({tabs,sections,buttons,footer})` | builds the sidebar skeleton |
| `rprofRow({name,meta,img,sel,onclick,btns})` | picker row markup |
| `setupAcc(panel,key,openDefault)` | accordionize `<h4>` sections |
| `initEdHeads(root)` | wire `[Cancel][Save]` on `.edhead` blocks |
| `mpOpenEditor/mode`, `mpCloseEditor`, `mpFlashSaved(msg)` | panel editor lifecycle + save toast |
| `draftFields(ids)` / `fillFields(d)` | preserve unsaved inputs across re-renders (call before/after `renderList()`) |
| `trigList(s)` | render a trigger string (`'a,b'` → `'a, b'`); always display triggers through it |
| `renderMprofPicker(rm, memProfiles)` | shared `#smart_mprof` follow-picker + hint (Memories/Stories) |
| `activateProf(id)` | activate a profile row |
| `mob()` | mobile breakpoint check |

Per-page boilerplate (copy this, don't reinvent):

```js
const H=()=>({'Content-Type':'application/json','Authorization':'Bearer '+(localStorage.mp_token||'')});
const api=(p,b)=>fetch(`/api/${p}`,{method:'POST',headers:H(),body:JSON.stringify(b||{})}).then(r=>r.status===401?location='/login.html':r.json());
const get=p=>fetch(`/api/${p}`,{headers:H()}).then(r=>r.status===401?location='/login.html':r.json());
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
```

## Render idiom

Pages re-render wholesale on state change (`renderList()` rebuilds
`#list.innerHTML`, then `setupAcc`/`initEdHeads` rewire). Interactive
sub-state = module-level id vars toggled by clicks (`editId`, `histId`,
`delPickId`, `permPickId`) — each toggle sets its var and re-renders.
Text inputs that must survive re-render go through `draftFields`/
`fillFields`; for click-only widgets (search-as-you-type filters) prefer
direct DOM show/hide so focus isn't lost.

## Mobile

`--mob` = 700px. Below it sidebars become overlay drawers (`.open` +
`.mp-scrim`); hover-only affordances need `display` fallbacks in the media
query. Every page needs the viewport meta tag or media queries never
fire.
