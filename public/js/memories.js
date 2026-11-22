const H=()=>({'Content-Type':'application/json','Authorization':'Bearer '+(localStorage.mp_token||'')});
const api=(p,b)=>fetch(`/api/${p}`,{method:'POST',headers:H(),body:JSON.stringify(b||{})}).then(r=>r.status===401?location='/login.html':r.json());
const get=p=>fetch(`/api/${p}`,{headers:H()}).then(r=>r.status===401?location='/login.html':r.json());
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
let ROOM=Number(localStorage.mp_room||1);
initSidebar({
  tabs:[{id:'t_manual',label:'Manual',on:true,onclick:"tab('user')"},{id:'t_smart',label:'Smart',onclick:"tab('smart')"}],
  sections:[{title:'Rooms',id:'rchat'},{title:'Characters',id:'rcards',wrap:'cardssec'}],
  footer:'Memory-writer profiles live on the <a href="/memsettings.html" style="color:var(--muted)">Memory profiles</a> page. Story threads have their own <a href="/stories.html" style="color:var(--muted)">Stories</a> page.',
});
let cardId=0,scopeName='',curTab=localStorage.mp_memtab||'user';if(!['user','smart'].includes(curTab))curTab='user';
let allMems=[],roomCards=[],memProfiles=[],editId=0,permPickId=0,histId=0,delPickId=0,retQ='',roomName='';
const TYPE_ORDER=['state','fact','event','relationship','preference'];
function tab(t){curTab=t;editId=0;permPickId=0;localStorage.mp_memtab=t;
  if(t==='smart'&&cardId!==0){cardId=0;scopeName='';}// smart memories are room-scoped
  load();
}
function renderList(){
  $('t_manual').classList.toggle('on',curTab==='user');
  $('t_smart').classList.toggle('on',curTab==='smart');
  if($('cardssec')) $('cardssec').style.display=curTab==='user'?'block':'none';
  $('smartbar').style.display=curTab==='smart'?'block':'none';
  $('btn_new').style.display=curTab==='user'?'':'none';
  if(curTab!=='user')$('newbox').style.display='none';
  const mems = allMems.filter(m=>(m.origin||m.source||'user')===curTab);
  // Group by type — every type renders as an accordion section, even empty.
  // The h4 carries just the type name (the .acc persistence key); the count
  // rides the header line as a .hint, which also keeps setupAcc's
  // placeholder-note heuristic quiet.
  const groups={};
  for(const m of mems){ const t=m.type||'fact'; (groups[t]=groups[t]||[]).push(m); }
  // State rows chain via superseded_by: follow it to the chain head — a
  // live row (null) or a retracted tombstone (self-reference). Only heads
  // render top-level; earlier versions collapse under the head's history.
  const byId=new Map(mems.map(m=>[m.id,m]));
  const headOf=m=>{const seen=new Set();let cur=m;
    while(cur.superseded_by_memories_id_fk&&cur.superseded_by_memories_id_fk!==cur.id&&!seen.has(cur.id)){
      seen.add(cur.id);cur=byId.get(cur.superseded_by_memories_id_fk)||cur;}
    return cur.id;};
  // History expands newest-first — the most recent draft sits directly
  // under the live card it fed into.
  const histOf=h=>mems.filter(m=>m!==h&&headOf(m)===h.id).sort((a,b)=>b.id-a.id);
  // Tombstones (superseded_by = self) render dimmed instead of a badge —
  // visually 'former', still clickable for delete/un-retract.
  const supTag=m=>m.superseded_by_memories_id_fk===m.id?''
    :(m.superseded_by_memories_id_fk?' <span class="mtag" title="Superseded — replaced by a newer memory, no longer injected">superseded</span>':'');
  const draft=editId?draftFields(['em_content_'+editId,'em_type_'+editId,'em_scope_'+editId,'em_trig_'+editId]):null;
  const memRow=m=>{const n=chainBehind(m.id).length,tomb=m.superseded_by_memories_id_fk===m.id;
    return `
    <div><div class="card"${m.superseded_by_memories_id_fk===m.id?' style="opacity:.65" title="Retracted — no longer in the live set"':' draggable="true" data-mid="'+m.id+'" title="Drag onto another card to link them as retellings — the newest telling stays live"'}>
      <div><div class="comment">${esc(m.content)}</div><div class="keys"><span class="mtag m${esc(m.type||'fact')}">${esc(m.type||'fact')}</span>${m.room_arcs_id_fk?' <span class="mtag" title="Folded under a story thread — injects via the thread, not standalone">folded</span>':''}${supTag(m)}${!m.triggers&&m.type!=='state'?' <span class="mtag" title="Always injected into the prompt">canon</span>':''} ${m.triggers?esc(trigList(m.triggers)):''}</div><div class="meta">#${m.id} · ${m.created||''} · ${curTab==='user'?esc(memScope(m.cards_id_fk)):'shared'}${m.last_fired_at?` · fired ${m.last_fired_at}`:(m.origin==='smart'&&m.triggers?' · never fired':'')}</div></div>
      <div class="btns">${histOf(m).length?`<button onclick="histToggle(${m.id})">${histId===m.id?'history ▾':'history ▸'} (${histOf(m).length})</button>`:''}<button onclick="editMem(${m.id})">Edit</button>${curTab==='smart'?`<button onclick="permPick(${m.id})">&rarr; manual</button>`:''}${delPickId===m.id
        ?`<div style="position:relative;display:flex;justify-content:flex-end"><button style="visibility:hidden" tabindex="-1">Cancel</button><div style="position:absolute;right:0;top:0;display:flex;gap:6px;white-space:nowrap"><button class="del" style="min-width:92px" title="${tomb?'Delete — un-retracts the previous version as current':n?'Delete — restores the previous version as current':'Delete this memory'}" onclick="delConfirm(${m.id},0)">Delete</button>${n?`<button class="del" style="min-width:92px" title="Delete this and its ${n} earlier version${n>1?'s':''}" onclick="delConfirm(${m.id},1)">Delete +${n}</button>`:''}<button onclick="delPick(${m.id})" style="min-width:92px">Cancel</button></div></div>`
        :`<button class="del" onclick="del(${m.id})">Delete</button>`}</div>
    </div>${histId===m.id?histOf(m).map(h=>`<div class="card" style="opacity:.65" draggable="true" data-uid="${h.id}" title="Drag out to restore this version as a live memory — or onto another card to move it under that chain"><div><div class="comment">${esc(h.content)}</div><div class="meta">#${h.id} · ${h.created||''} · replaced</div></div></div>`).join(''):''}${permPicker(m)}</div>`};
  // Live set = superseded_by NULL for every type (tombstones live in the
  // Retracted section instead). The search hides .rcard wrappers directly
  // — no re-render, so the input keeps focus while typing.
  const ret=mems.filter(m=>m.superseded_by_memories_id_fk===m.id);
  $('list').innerHTML=TYPE_ORDER.map(t=>{
    const rows=groups[t]||[];
    const show=rows.filter(m=>!m.superseded_by_memories_id_fk);
    return `<h4>${esc(t[0].toUpperCase()+t.slice(1))}</h4><span class="hint">${show.length}</span>${show.length?show.map(m=>editId===m.id?editForm(m):memRow(m)).join(''):'<small>None</small>'}`;
  }).join('')+`<h4>Retracted</h4><span class="hint">${ret.length}</span>${ret.length
    ?`<input id="retq" placeholder="search retracted…" value="${esc(retQ)}" oninput="retSearch(this.value)" style="margin:4px 0 8px;width:100%;box-sizing:border-box"><div id="retlist">${ret.map(m=>`<div class="rcard">${memRow(m)}</div>`).join('')}</div>`
    :'<small>None</small>'}`;
  setupAcc($('list'),'mp_mem_acc',TYPE_ORDER.map(t=>t[0].toUpperCase()+t.slice(1)).concat('Retracted'));
  initEdHeads($('list'));if(draft&&editId)fillFields(draft);if(retQ)retSearch(retQ);
}
function retSearch(q){retQ=q;const nq=q.trim().toLowerCase();
  for(const el of document.querySelectorAll('#retlist .rcard'))
    el.style.display=!nq||el.textContent.toLowerCase().includes(nq)?'':'none'}
function histToggle(id){histId=histId===id?0:id;renderList()}
function editMem(id){editId=editId===id?0:id;renderList();document.querySelector('.card.editing')?.scrollIntoView({behavior:'smooth',block:'nearest'})}
function editForm(m){
  const types=[...new Set(['fact','event','relationship','preference',m.type||'fact'])]; // keep exotic types (state) selectable so editing can't clobber them
  const scopeOpts=`<option value="0"${!m.cards_id_fk?' selected':''}>${esc(roomName||'This chat')} (shared)</option>`+
    roomCards.map(c=>`<option value="${c.id}"${m.cards_id_fk===c.id?' selected':''}>${esc(c.name)}</option>`).join('');
  return `<div class="card editing">
    <div class="edhead" data-save="saveEdit" data-cancel="cancelEdit"><h3>Edit memory #${m.id}</h3></div>
    <textarea id="em_content_${m.id}" style="min-height:60px;width:100%">${esc(m.content)}</textarea>
    <div style="display:flex;gap:6px;margin-top:6px;align-items:center;flex-wrap:wrap">
      <select id="em_type_${m.id}" style="width:auto">${types.map(t=>`<option${t===(m.type||'fact')?' selected':''}>${t}</option>`).join('')}</select>
      ${curTab==='user'?`<select id="em_scope_${m.id}" style="width:auto">${scopeOpts}</select>`:''}
    </div>
    <input id="em_trig_${m.id}" placeholder="trigger keywords — empty = canon (always in the prompt)" value="${esc(trigList(m.triggers))}" style="width:100%;margin-top:6px;font-size:.85em">
  </div>`;
}
function cancelEdit(){editId=0;renderList()}
async function saveEdit(){
  const id=editId;const m=allMems.find(x=>x.id===id);if(!m)return;
  await api('memories/update',{id,content:$('em_content_'+id).value,type:$('em_type_'+id).value,triggers:$('em_trig_'+id).value});
  if(curTab==='user'){
    const scope=Number($('em_scope_'+id).value)||0;
    if(scope!==(m.cards_id_fk||0)) await api('memories/move',{id,cardId:scope||null});
  }
  editId=0;mpFlashSaved();load();
}
const memScope=id=>id?(roomCards.find(c=>c.id===id)?.name||'#'+id):'shared';
async function load(){
  const [{cards},{rooms},mps]=await Promise.all([get('cards'),get('rooms'),get('memprofiles')]);
  roomCards=cards||[];
  memProfiles=mps?.profiles||[];
  if ((rooms||[]).length && !(rooms||[]).some(r=>r.id===ROOM)) { ROOM=rooms[0].id; localStorage.mp_room=ROOM; }
  const rm=(rooms||[]).find(r=>r.id===ROOM);
  roomName=rm?.name||'Chat';
  renderMprofPicker(rm,memProfiles);
  $('rchat').innerHTML=(rooms||[]).map(r=>
    rprofRow({name:esc(r.name),meta:'shared memories',sel:r.id===ROOM,onclick:`pickRoom(${r.id})`})
    ).join('')||'<small>None</small>';
  $('rcards').innerHTML=(cards||[]).map(c=>
      rprofRow({img:`<img src="/api/avatar?id=${c.id}" onerror="this.style.visibility='hidden'">`,name:esc(c.name),meta:esc(c.owner||'?'),sel:c.id===cardId,onclick:`pick(${c.id},'${esc(c.name).replace(/'/g,"\\'")}')`})
    ).join('')||'<small>None</small>';
  if(cardId<0)cardId=0;
  allMems=(await get(`memories?card=${cardId}&room=${ROOM}`)).memories||[];
  $('title').textContent=`${scopeName||roomName||'Memories'} — ${curTab==='smart'?'smart ':''}memories`;
  renderList();
}
function pick(id,name){cardId=id;scopeName=name;load()}
function pickRoom(id){ROOM=id;localStorage.mp_room=ROOM;cardId=0;scopeName='';load()}
async function pickMProf(v){await api('room/memsettings',{room:ROOM,memProfile:Number(v)||0});load()}
async function dedupeMems(){
  const r=await api('memories/dedupe',{room:ROOM});
  const n=r.merged?.length||0;
  $('dedupe_hint').textContent=n?`retired ${n} retold ${n===1?'version':'versions'} — see history on the latest telling`:'no retellings found';
  load();
}
function newMem(){$('newbox').style.display='block';$('newmem').focus()}
function cancelNew(){$('newmem').value='';$('newtrig').value='';$('newbox').style.display='none'}
async function saveNew(){const t=$('newmem').value.trim();if(!t)return;$('newmem').value='';await api('memories',{cardId,room:ROOM,content:t,type:$('newtype').value,triggers:$('newtrig').value.trim()});$('newtrig').value='';mpFlashSaved();load()}
// Every version a row superseded — walk superseded_by backwards.
function chainBehind(id){const out=[],seen=new Set([id]),q=[id];
  while(q.length){const cid=q.shift();
    for(const p of allMems.filter(x=>x.superseded_by_memories_id_fk===cid))
      if(!seen.has(p.id)){seen.add(p.id);out.push(p)}}
  return out}
function del(id){delPickId=delPickId===id?0:id;renderList()}
function delPick(id){delPickId=delPickId===id?0:id;renderList()}
async function delConfirm(id,chain){delPickId=0;await api('memories/delete',{id,chain:!!chain});load()}
function permPick(id){permPickId=permPickId===id?0:id;renderList()}
function permPicker(m){if(permPickId!==m.id)return'';
  const cards=roomCards.map(c=>`<button onclick="moveToPerm(${m.id},${c.id})">${esc(c.name)}</button>`).join('');
  return `<div class="card editing"><div class="desc">Move to manual — pick a scope:</div><div class="btns" style="flex-direction:row;flex-wrap:wrap"><button onclick="moveToPerm(${m.id},0)">${esc(roomName||'This chat')}</button>${cards}</div></div>`}
async function moveToPerm(id,cid){const m=allMems.find(x=>x.id===id);if(!m)return;
  await api('memories',{content:m.content,type:m.type||'fact',triggers:m.triggers||'',room:ROOM,cardId:cid||0});
  await api('memories/delete',{id});permPickId=0;load()}
// Kanban link — drag a live card onto another to merge their chains
// (server resolves order by `created`), or drag a dimmed history card
// out onto empty space to detach it live again; dropping it on another
// live card moves that version under the target's chain instead.
// Delegated so re-renders don't rewire.
let dragMem=null;
const srcCard=e=>e.target.closest?.('.card[draggable]');
const tgtCard=e=>e.target.closest?.('.card[data-mid]'); // drop targets are live heads only — history cards carry data-uid
$('list').addEventListener('dragstart',e=>{const c=srcCard(e);if(!c)return;
  dragMem={id:Number(c.dataset.mid||c.dataset.uid),unlink:!!c.dataset.uid};
  c.classList.add('dragging');e.dataTransfer.effectAllowed='link'});
$('list').addEventListener('dragend',()=>{dragMem=null;for(const c of $('list').querySelectorAll('.dragging,.drop-tgt'))c.classList.remove('dragging','drop-tgt')});
$('list').addEventListener('dragover',e=>{if(!dragMem)return;e.preventDefault();
  const c=tgtCard(e);
  for(const x of $('list').querySelectorAll('.drop-tgt'))x.classList.remove('drop-tgt');
  if(c&&Number(c.dataset.mid)!==dragMem.id){e.dataTransfer.dropEffect='link';c.classList.add('drop-tgt')}});
$('list').addEventListener('drop',async e=>{if(!dragMem)return;e.preventDefault();
  const under=srcCard(e),underId=under?Number(under.dataset.mid||under.dataset.uid):0,d=dragMem;dragMem=null;
  if(underId===d.id)return; // released on itself — not a gesture
  const c=tgtCard(e),tgt=c&&Number(c.dataset.mid)!==d.id?Number(c.dataset.mid):0;
  if(d.unlink)await unlinkMem(d.id,tgt);
  else if(tgt)await linkMem(d.id,tgt)});
async function linkMem(id,target){
  const r=await api('memories/link',{id,target});
  if(r.error)return alert(r.error);
  mpFlashSaved('Linked — newest telling stays live');load();
}
async function unlinkMem(id,target){
  const r=await api('memories/unlink',{id,target});
  if(r.error)return alert(r.error);
  mpFlashSaved(target?'Moved under that telling':'Restored to the live set');load();
}
// Touch fallback — drag events never fire on touch browsers, so a
// ~400ms hold picks the card up (a finger that moves sooner was a
// scroll). elementFromPoint hit-tests the target; release drops.
let td=null;
$('list').addEventListener('touchstart',e=>{
  const c=srcCard(e);if(!c||td||e.touches.length>1)return;
  const t=e.touches[0];
  td={id:Number(c.dataset.mid||c.dataset.uid),unlink:!!c.dataset.uid,card:c,x:t.clientX,y:t.clientY,active:false,
    timer:setTimeout(()=>{td.active=true;c.classList.add('dragging');
      td.ghost=document.createElement('div');td.ghost.className='drag-ghost';
      td.ghost.textContent=c.querySelector('.comment')?.textContent.slice(0,60)||'#'+td.id;
      document.body.appendChild(td.ghost);
      td.ghost.style.left=t.clientX+'px';td.ghost.style.top=t.clientY+'px';
      navigator.vibrate?.(15)},400)};
});
$('list').addEventListener('touchmove',e=>{
  if(!td)return;const t=e.touches[0];
  if(!td.active){if(Math.hypot(t.clientX-td.x,t.clientY-td.y)>10){clearTimeout(td.timer);td=null}return}
  e.preventDefault();
  td.ghost.style.left=t.clientX+'px';td.ghost.style.top=t.clientY+'px';
  const over=document.elementFromPoint(t.clientX,t.clientY)?.closest?.('.card[data-mid]');
  for(const x of $('list').querySelectorAll('.drop-tgt'))x.classList.remove('drop-tgt');
  if(over&&Number(over.dataset.mid)!==td.id)over.classList.add('drop-tgt');
},{passive:false});
const endTouch=async e=>{
  if(!td)return;clearTimeout(td.timer);
  if(!td.active){td=null;return}
  const t=e.changedTouches[0],id=td.id,unlink=td.unlink;
  td.card.classList.remove('dragging');td.ghost?.remove();
  for(const x of $('list').querySelectorAll('.drop-tgt'))x.classList.remove('drop-tgt');
  td=null;
  const el=document.elementFromPoint(t.clientX,t.clientY);
  const under=el?.closest?.('.card[draggable]'),underId=under?Number(under.dataset.mid||under.dataset.uid):0;
  if(underId===id)return; // released on itself — not a gesture
  const over=el?.closest?.('.card[data-mid]'),tgt=over&&Number(over.dataset.mid)!==id?Number(over.dataset.mid):0;
  if(unlink){ // released inside the list detaches; outside it cancels
    if(el&&$('list').contains(el))await unlinkMem(id,tgt);
  }else if(tgt)await linkMem(id,tgt);
};
$('list').addEventListener('touchend',endTouch);
$('list').addEventListener('touchcancel',endTouch);
$('list').addEventListener('contextmenu',e=>{if(td)e.preventDefault()}); // long-press menu would fight the pickup
load();
