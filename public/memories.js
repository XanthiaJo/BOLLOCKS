/* global rowToProf */
const H=()=>({'Content-Type':'application/json','Authorization':'Bearer '+(localStorage.mp_token||'')});
const api=(p,b)=>fetch(`/api/${p}`,{method:'POST',headers:H(),body:JSON.stringify(b||{})}).then(r=>r.status===401?location='/login.html':r.json());
const get=p=>fetch(`/api/${p}`,{headers:H()}).then(r=>r.status===401?location='/login.html':r.json());
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
let ROOM=Number(localStorage.mp_room||1);
initSidebar({
  tabs:[{id:'t_perm',label:'Permanent',on:true,onclick:"tab('user')"},{id:'t_auto',label:'Smart',onclick:"tab('smart')"}],
  sections:[{title:'Rooms',id:'rchat'},{title:'Characters',id:'rcards',wrap:'cardssec'}],
  footer:'Smart-memory profiles live on the <a href="/memsettings.html" style="color:var(--muted)">Smart memory</a> page.',
});
let cardId=0,scopeName='',curTab=localStorage.mp_memtab||'user';if(!['user','smart'].includes(curTab))curTab='user';
let allMems=[];
const TYPE_ORDER=['fact','event','relationship','preference'];
function tab(t){if(t==='smart' && cardId!==0){cardId=0;scopeName='';} curTab=t; localStorage.mp_memtab=curTab;
  $('t_perm').classList.toggle('on',t==='user');
  $('t_auto').classList.toggle('on',t==='smart');
  load();
}
function renderList(){
  $('t_perm').classList.toggle('on',curTab==='user');
  $('t_auto').classList.toggle('on',curTab==='smart');
  if($('cardssec')) $('cardssec').style.display=curTab==='smart'?'none':'block';
  const sb=$('smartbar'); if(sb) sb.style.display=curTab==='smart'?'block':'none';
  const mems = allMems.filter(m=>(m.origin||m.source||'user')===curTab);
  $('btn_new').style.display=curTab==='user'?'':'none';
  if(curTab!=='user')$('newbox').style.display='none';
  // Group by type.
  const groups={};
  for(const m of mems){ const t=m.type||'fact'; (groups[t]=groups[t]||[]).push(m); }
  const draft=editId?draftFields(['em_content_'+editId,'em_type_'+editId,'em_scope_'+editId,'em_trig_'+editId]):null;
  const html=TYPE_ORDER.filter(t=>groups[t]?.length).map(t=>`
    <h4 style="margin:12px 0 4px;color:var(--dim);font-size:.85em;text-transform:uppercase;letter-spacing:.04em">${esc(t)} (${groups[t].length})</h4>
    ${groups[t].map(m=>editId===m.id?editForm(m):`
    <div class="card">
      <div><div class="comment">${esc(m.content)}</div><div class="keys"><span class="mtag m${esc(m.type||'fact')}">${esc(m.type||'fact')}</span> ${m.triggers?esc(m.triggers):'(always on)'}</div><div class="meta">#${m.id} · ${m.created||''} · ${esc(memScope(m.cards_id_fk))}</div></div>
      <div class="btns"><button onclick="editMem(${m.id})">Edit</button>${curTab==='smart'?`<button onclick="permPick(${m.id})">&rarr; perm</button>`:(cardId===0?`<button onclick="toSmart(${m.id})">&rarr; smart</button>`:'')}<button class="del" onclick="del(${m.id})">Delete</button></div>
    </div>
    ${permPicker(m)}</div>`).join('')}`).join('');
  $('list').innerHTML=html||`<small>No ${curTab==='smart'?'smart':'permanent'} memories yet.</small>`;
  initEdHeads($('list'));if(draft&&editId)fillFields(draft);
}

let roomCards=[];let memProfiles=[];let editId=0;
function editMem(id){editId=editId===id?0:id;renderList();document.querySelector('.card.editing')?.scrollIntoView({behavior:'smooth',block:'nearest'})}
function editForm(m){
  const types=['fact','event','relationship','preference'];
  const scopeOpts=`<option value="0"${!m.cards_id_fk?' selected':''}>${esc(roomName||'This chat')} (shared)</option>`+
    roomCards.map(c=>`<option value="${c.id}"${m.cards_id_fk===c.id?' selected':''}>${esc(c.name)}</option>`).join('');
  return `<div class="card editing">
    <div class="edhead" data-save="saveEdit" data-cancel="cancelEdit"><h3>Edit memory #${m.id}</h3></div>
    <textarea id="em_content_${m.id}" style="min-height:60px;width:100%">${esc(m.content)}</textarea>
    <div style="display:flex;gap:6px;margin-top:6px;align-items:center;flex-wrap:wrap">
      <select id="em_type_${m.id}" style="width:auto">${types.map(t=>`<option${t===(m.type||'fact')?' selected':''}>${t}</option>`).join('')}</select>
      <select id="em_scope_${m.id}" style="width:auto">${scopeOpts}</select>
    </div>
    <input id="em_trig_${m.id}" placeholder="trigger keywords" value="${esc(m.triggers||'')}" style="width:100%;margin-top:6px;font-size:.85em">
  </div>`;
}
function cancelEdit(){editId=0;renderList()}
async function saveEdit(){
  const id=editId;const m=allMems.find(x=>x.id===id);if(!m)return;
  await api('memories/update',{id,content:$('em_content_'+id).value,type:$('em_type_'+id).value,triggers:$('em_trig_'+id).value});
  const scope=Number($('em_scope_'+id).value)||0;
  if(scope!==(m.cards_id_fk||0)) await api('memories/move',{id,cardId:scope||null});
  editId=0;load();
}
const memScope=id=>id?(roomCards.find(c=>c.id===id)?.name||'#'+id):'shared';
let roomName='';
async function load(){
  const [{cards},{rooms},mps]=await Promise.all([get('cards'),get('rooms'),get('memprofiles')]);
  roomCards=cards||[];
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
    ? (followed?`This chat follows "${followed.name}" — edit it on the Smart memory page.`
        :memProfiles.length?'Smart memories are off — pick a profile to enable.':'No profiles yet — create one on the Smart memory page.')
    : (followedName?`This chat follows "${followedName}". `:'Smart memories are off. ')+'Only the room owner can change the memory profile.';
  const smartP=followed||null;
  // Non-owners see the followed profile's flag (from the room payload), not their own.
  $('smart_auto').checked=rm?.is_owner?!!smartP?.auto_mem:!!rm?.mem_profile_auto;
  $('smart_auto').disabled=!rm?.is_owner?true:!smartP;
  $('smart_mprof').disabled=!rm?.is_owner;
  $('rchat').innerHTML=
    rprofRow({name:esc(roomName),meta:'shared memories',sel:cardId===0,onclick:`pick(0,'${esc(roomName)}')`});
  $('rcards').innerHTML=(cards||[]).map(c=>
      rprofRow({img:`<img src="/api/avatar?id=${c.id}" onerror="this.style.visibility='hidden'">`,name:esc(c.name),meta:esc(c.owner||'?'),sel:c.id===cardId,onclick:`pick(${c.id},'${esc(c.name).replace(/'/g,"\\'")}')`})
    ).join('')||'<small>None</small>';
  if(cardId<0)cardId=0;
  const {memories}=await get(`memories?card=${cardId}&room=${ROOM}`);
  allMems=memories||[];
  $('title').textContent=`${scopeName||roomName||'Memories'} — memories`;
  renderList();
}
function pick(id,name){cardId=id;scopeName=name;if(id!==0 && curTab==='smart') curTab='user';load()}
async function toggleSmartAuto(on){const id=Number($('smart_mprof').value);if(!id)return;const p=memProfiles.find(x=>x.mem_profiles_id_pk===id);if(!p)return;await api('memprofiles/update',{...rowToProf(p),auto:on?1:0});load()}
async function pickMProf(v){await api('room/memsettings',{room:ROOM,memProfile:Number(v)||0});load()}
function newMem(){$('newbox').style.display='block';$('newmem').focus()}
function cancelNew(){$('newmem').value='';$('newbox').style.display='none'}
async function saveNew(){const t=$('newmem').value.trim();if(!t)return;$('newmem').value='';await api('memories',{cardId,room:ROOM,content:t,type:$('newtype').value});load()}
async function toSmart(id){await api('memories/update',{id,origin:'smart'});load()}
async function del(id){if(confirm('Forget this memory?')){await api('memories/delete',{id});load()}}
let permPickId=0;
function permPick(id){permPickId=permPickId===id?0:id;renderList()}
function permPicker(m){if(permPickId!==m.id)return'';
  const cards=roomCards.map(c=>`<button onclick="moveToPerm(${m.id},${c.id})">${esc(c.name)}</button>`).join('');
  return `<div class="card editing"><div class="desc">Move to permanent — pick a scope:</div><div class="btns" style="flex-direction:row;flex-wrap:wrap"><button onclick="moveToPerm(${m.id},0)">${esc(roomName||'This chat')}</button>${cards}</div></div>`}
async function moveToPerm(id,cid){const m=allMems.find(x=>x.id===id);if(!m)return;
  await api('memories',{content:m.content,type:m.type||'fact',triggers:m.triggers||'',room:ROOM,cardId:cid||0});
  await api('memories/delete',{id});permPickId=0;load()}
