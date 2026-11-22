// --- Stories page: room story threads. Manual = opened by you; Smart = tracked by extraction. ---
const H=()=>({'Content-Type':'application/json','Authorization':'Bearer '+(localStorage.mp_token||'')});
const api=(p,b)=>fetch(`/api/${p}`,{method:'POST',headers:H(),body:JSON.stringify(b||{})}).then(r=>r.status===401?location='/login.html':r.json());
const get=p=>fetch(`/api/${p}`,{headers:H()}).then(r=>r.status===401?location='/login.html':r.json());
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
let ROOM=Number(localStorage.mp_room||1);
initSidebar({
  tabs:[{id:'t_manual',label:'Manual',on:true,onclick:"tab('user')"},{id:'t_smart',label:'Smart',onclick:"tab('smart')"}],
  sections:[{title:'Chats',id:'rchat'}],
  footer:'Manual threads are ones you opened. Smart threads are opened, advanced, and closed by the memory-writer.',
});
let curTab=localStorage.mp_storytab||'user';if(!['user','smart'].includes(curTab))curTab='user';
let allArcs=[],memProfiles=[],editId=0,extId=0,roomName='';
function tab(t){curTab=t;editId=0;localStorage.mp_storytab=t;renderList()}
function renderList(){
  $('t_manual').classList.toggle('on',curTab==='user');
  $('t_smart').classList.toggle('on',curTab==='smart');
  $('smartbar').style.display=curTab==='smart'?'block':'none';
  $('btn_new').style.display=curTab==='user'?'':'none';
  if(curTab!=='user')$('newarcbox').style.display='none';
  const arcs=allArcs.filter(a=>(a.origin||'user')===curTab);
  const draft=editId?draftFields(['ea_title_'+editId,'ea_summary_'+editId]):null;
  const card=a=>editId===a.id?arcForm(a):`
  <div><div class="card">
    <div><div class="comment">${esc(a.title)}</div>${a.summary?`<div class="keys">${esc(a.summary)}</div>`:''}<div class="meta">#${a.id} · ${esc(a.status)} · ${a.updated||a.created||''}</div></div>
    <div class="btns">${a.mems?.length?`<button onclick="arcToggle(${a.id})">${extId===a.id?'extractions ▾':'extractions ▸'} (${a.mems.length})</button>`:''}<button onclick="editArc(${a.id})">Edit</button>${a.status==='open'?`<button onclick="resolveArc(${a.id})">Resolve</button>`:`<button onclick="reopenArc(${a.id})">Reopen</button>`}<button class="del" onclick="delArc(${a.id})">Delete</button></div>
  </div>${extId===a.id?(a.mems||[]).map(m=>`<div class="card" style="opacity:.65"><div><div class="comment"><span class="mtag m${esc(m.type||'fact')}">${esc(m.type||'fact')}</span> ${esc(m.content)}</div><div class="meta">#${m.id} · ${m.created||''} · folded extraction${m.sup?' · superseded':''}${m.triggers?` · ${esc(trigList(m.triggers))}`:''}</div></div></div>`).join(''):''}</div>`;
  const open=arcs.filter(a=>a.status==='open'),closed=arcs.filter(a=>a.status!=='open');
  $('list').innerHTML=
    `<span class="hint" style="display:block;margin-bottom:8px">${curTab==='smart'
      ?'Threads the memory-writer opened on its own — it keeps them in the prompt and closes them when the storyline resolves.'
      :'Open storylines the AI keeps in the prompt until resolved — open them here, or let extraction track them on the Smart tab.'}</span>`+
    (arcs.length?open.map(card).join('')+(closed.length?`<h4 style="margin:12px 0 4px;color:var(--dim);font-size:.85em;text-transform:uppercase;letter-spacing:.04em">closed (${closed.length})</h4>`+closed.map(card).join(''):'')
      :`<small>No ${curTab==='smart'?'smart':'manual'} threads yet${curTab==='smart'?' — extraction opens them as storylines emerge':' — open one to track an unfolding storyline'}.</small>`);
  initEdHeads($('list'));if(draft&&editId)fillFields(draft);
}
function arcForm(a){
  return `<div class="card editing">
    <div class="edhead" data-save="saveArc" data-cancel="cancelArc"><h3>Edit thread #${a.id}</h3></div>
    <input id="ea_title_${a.id}" value="${esc(a.title)}" placeholder="Thread title" style="width:100%">
    <textarea id="ea_summary_${a.id}" placeholder="Current beat" style="min-height:50px;width:100%;margin-top:4px">${esc(a.summary||'')}</textarea>
  </div>`;
}
function arcToggle(id){extId=extId===id?0:id;renderList()}
function editArc(id){editId=editId===id?0:id;renderList()}
function cancelArc(){editId=0;renderList()}
async function saveArc(){const id=editId;if(!allArcs.find(x=>x.id===id))return;
  await api('arcs/update',{id,title:$('ea_title_'+id).value,summary:$('ea_summary_'+id).value});editId=0;mpFlashSaved();load()}
async function resolveArc(id){await api('arcs/resolve',{id});load()}
async function reopenArc(id){await api('arcs/update',{id,status:'open'});load()}
async function delArc(id){if(confirm('Delete this thread?')){await api('arcs/delete',{id});load()}}
function newArc(){$('newarcbox').style.display='block';$('newarctitle').focus()}
function cancelNewArc(){$('newarctitle').value='';$('newarcsummary').value='';$('newarcbox').style.display='none'}
async function saveNewArc(){const t=$('newarctitle').value.trim();if(!t)return;
  await api('arcs',{room:ROOM,title:t,summary:$('newarcsummary').value.trim()});cancelNewArc();mpFlashSaved();load()}
async function load(){
  const [{rooms},mps]=await Promise.all([get('rooms'),get('memprofiles')]);
  memProfiles=mps?.profiles||[];
  if ((rooms||[]).length && !(rooms||[]).some(r=>r.id===ROOM)) { ROOM=rooms[0].id; localStorage.mp_room=ROOM; }
  const rm=(rooms||[]).find(r=>r.id===ROOM);
  roomName=rm?.name||'Chat';
  // Smart tab: picker showing which profile this chat follows.
  const followed=(rm?.mem_profiles_id_fk)&&(memProfiles.find(x=>x.mem_profiles_id_pk===rm.mem_profiles_id_fk))||null;
  const mprofOpts=(memProfiles||[]).map(p=>`<option value="${p.mem_profiles_id_pk}">${esc(p.name)}</option>`).join('');
  const mprofVal=String(rm?.mem_profiles_id_fk ?? 0);
  // Non-owners can't see the owner's profile list — show the followed name only.
  const followedName=followed?.name||rm?.mem_profile_name||null;
  $('smart_mprof').innerHTML=rm?.is_owner?`<option value="0">Disabled</option>`+mprofOpts:`<option>${esc(followedName||'Disabled')}</option>`;
  $('smart_mprof').value=mprofVal;
  $('smart_mprof_hint').textContent=rm?.is_owner
    ? (followed?`This chat follows "${followed.name}" — edit it on the Memory profiles page.`
        :memProfiles.length?'Smart memory is off — pick a profile to enable.':'No profiles yet — create one on the Memory profiles page.')
    : (followedName?`This chat follows "${followedName}". `:'Smart memory is off. ')+'Only the room owner can change the memory profile.';
  $('smart_mprof').disabled=!rm?.is_owner;
  $('rchat').innerHTML=(rooms||[]).map(r=>
    rprofRow({name:esc(r.name),meta:'story threads',sel:r.id===ROOM,onclick:`pickRoom(${r.id})`})
    ).join('')||'<small>No chats yet.</small>';
  allArcs=(await get(`arcs?room=${ROOM}`)).arcs||[];
  $('title').textContent=`${roomName} — threads`;
  renderList();
}
function pickRoom(id){ROOM=id;localStorage.mp_room=ROOM;editId=0;load()}
async function pickMProf(v){await api('room/memsettings',{room:ROOM,memProfile:Number(v)||0});load()}
load();
