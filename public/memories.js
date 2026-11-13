/* global selProf, effRow, setSelProf, fillProf */
const H=()=>({'Content-Type':'application/json','Authorization':'Bearer '+(localStorage.mp_token||'')});
const api=(p,b)=>fetch(`/api/${p}`,{method:'POST',headers:H(),body:JSON.stringify(b||{})}).then(r=>r.status===401?location='/login.html':r.json());
const get=p=>fetch(`/api/${p}`,{headers:H()}).then(r=>r.status===401?location='/login.html':r.json());
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
let ROOM=Number(localStorage.mp_room||1);
let cardId=0,scopeName='',curTab=localStorage.mp_memtab||'user',allMems=[];
const TYPE_ORDER=['fact','event','relationship','preference'];
function tab(t){if(t==='smart' && cardId!==0) return; curTab=t; localStorage.mp_memtab=curTab;
  $('t_perm').classList.toggle('on',t==='user');
  $('t_auto').classList.toggle('on',t==='smart');
  $('t_set').classList.toggle('on',t==='settings');
  renderList();
}
function renderList(){
  $('t_perm').classList.toggle('on',curTab==='user');
  $('t_auto').classList.toggle('on',curTab==='smart');
  $('t_set').classList.toggle('on',curTab==='settings');
  const sb=$('smartbar'); if(sb) sb.style.display=curTab==='smart'?'block':'none';
  if($('profpanel')) $('profpanel').style.display=(curTab==='settings'&&selProf)?'block':'none';
  const mems = curTab==='settings'?[]:allMems.filter(m=>(m.origin||m.source||'user')===curTab);
  $('addbox').style.display=curTab==='user'?'block':'none';
  $('setpanel').style.display=curTab==='settings'?'block':'none';
  if(curTab==='settings'){ $('list').innerHTML=''; return; }
  // Group by type.
  const groups={};
  for(const m of mems){ const t=m.type||'fact'; (groups[t]=groups[t]||[]).push(m); }
  const html=TYPE_ORDER.filter(t=>groups[t]?.length).map(t=>`
    <h4 style="margin:12px 0 4px;color:var(--dim);font-size:.85em;text-transform:uppercase;letter-spacing:.04em">${esc(t)} (${groups[t].length})</h4>
    ${groups[t].map(m=>editId===m.id?editForm(m):`
    <div class="card">
      <div><div class="desc"><span class="mtag m${esc(m.type||'fact')}">${esc(m.type||'fact')}</span> ${esc(m.content)}</div><div class="meta">#${m.id} · ${m.created||''} · ${esc(memScope(m.cards_id_fk))}</div>
      <input placeholder="trigger keywords — inject only when mentioned" value="${esc(m.triggers||'')}" style="font-size:.8em;margin-top:4px;width:70%" onchange="api('memories/triggers',{id:${m.id},triggers:this.value})"></div>
      <div class="btns"><button onclick="editMem(${m.id})">Edit</button>${curTab==='smart'?`<button onclick="permPick(${m.id})">&rarr; perm</button>`:(cardId===0?`<button onclick="toSmart(${m.id})">&rarr; smart</button>`:'')}<button class="del" onclick="del(${m.id})">Delete</button></div>
    </div>
    ${permPicker(m)}</div>`).join('')}`).join('');
  $('list').innerHTML=html||`<small>No ${curTab==='smart'?'smart':'permanent'} memories yet.</small>`;
}

let roomCards=[];let memProfiles=[];let editId=0;let defPrompt='';let promptBlocks=[];
function editMem(id){editId=editId===id?0:id;renderList()}
function editForm(m){
  const types=['fact','event','relationship','preference'];
  const scopeOpts=`<option value="0"${!m.cards_id_fk?' selected':''}>${esc(roomName||'This chat')} (shared)</option>`+
    roomCards.map(c=>`<option value="${c.id}"${m.cards_id_fk===c.id?' selected':''}>${esc(c.name)}</option>`).join('');
  return `<div class="card" style="border-color:var(--accent)">
    <textarea id="em_content_${m.id}" style="min-height:60px;width:100%">${esc(m.content)}</textarea>
    <div style="display:flex;gap:6px;margin-top:6px;align-items:center;flex-wrap:wrap">
      <select id="em_type_${m.id}" style="width:auto">${types.map(t=>`<option${t===(m.type||'fact')?' selected':''}>${t}</option>`).join('')}</select>
      <select id="em_scope_${m.id}" style="width:auto">${scopeOpts}</select>
    </div>
    <input id="em_trig_${m.id}" placeholder="trigger keywords" value="${esc(m.triggers||'')}" style="width:100%;margin-top:6px;font-size:.85em">
    <div class="btns" style="margin-top:6px"><button onclick="saveEdit(${m.id})">Save</button><button onclick="editMem(${m.id})">Cancel</button></div>
  </div>`;
}
async function saveEdit(id){
  const m=allMems.find(x=>x.id===id);if(!m)return;
  await api('memories/update',{id,content:$('em_content_'+id).value,type:$('em_type_'+id).value,triggers:$('em_trig_'+id).value});
  const scope=Number($('em_scope_'+id).value)||0;
  if(scope!==(m.cards_id_fk||0)) await api('memories/move',{id,cardId:scope||null});
  editId=0;load();
}
const memScope=id=>id?(roomCards.find(c=>c.id===id)?.name||'#'+id):'shared';
async function move(id,cardId){await api('memories/move',{id,cardId:Number(cardId)||null});load();}
let roomName='';
async function load(){
  const [{cards},{rooms},{profiles},mps]=await Promise.all([get('cards'),get('rooms'),get('profiles'),get('memprofiles')]);
  roomCards=cards||[];
  memProfiles=mps?.profiles||[];defPrompt=mps?.defaultPrompt||'';promptBlocks=mps?.promptBlocks||[];
  const profOpts='<option value="0">— none (extraction off) —</option>'+(profiles||[]).map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join('');
  $('set_profile').innerHTML=profOpts;
  if ((rooms||[]).length && !(rooms||[]).some(r=>r.id===ROOM)) { ROOM=rooms[0].id; localStorage.mp_room=ROOM; }
  const rm=(rooms||[]).find(r=>r.id===ROOM);
  roomName=rm?.name||'Chat';
  // What "current" means for Save-current-as-profile: the profile this chat
  // follows (now always a profile — there is no per-chat custom option).
  const followed=(rm?.mem_profiles_id_fk)&&(memProfiles.find(x=>x.mem_profiles_id_pk===rm.mem_profiles_id_fk))||null;
  effRow=followed||memProfiles[0]||null;
  // Smart tab: picker showing which profile this chat follows.
  const mprofOpts=(memProfiles||[]).map(p=>`<option value="${p.mem_profiles_id_pk}">${esc(p.name)}</option>`).join('');
  const mprofVal=String(followed?.mem_profiles_id_pk ?? memProfiles[0]?.mem_profiles_id_pk ?? '');
  $('smart_mprof').innerHTML=mprofOpts;$('smart_mprof').value=mprofVal;
  $('smart_mprof_hint').textContent=followed?`This chat follows "${followed.name}" — edit it on the Settings tab.`:'No profiles yet — create one on the Settings tab.';
  const smartP=followed||memProfiles[0]||null;
  $('smart_auto').checked=!!smartP?.auto_mem;$('smart_auto').disabled=!smartP||!rm?.is_owner;
  $('smart_mprof').disabled=!rm?.is_owner;
  if(!rm?.is_owner)$('smart_mprof_hint').textContent='Only the room owner can change the memory profile.';
  // Settings tab: profiles list (panel 1); selected profile's settings (panel 2).
  $('mprof_list').innerHTML=(memProfiles||[]).map(p=>
    `<div class="mprofrow${p.mem_profiles_id_pk===selProf?' sel':''}" style="cursor:pointer" onclick="selectProf(${p.mem_profiles_id_pk})"><span class="n">${esc(p.name)}${p.auto_mem?' <small>smart on</small>':''}</span><button onclick="event.stopPropagation();delMP(${p.mem_profiles_id_pk})" class="del">Delete</button></div>`).join('')||'<small>No profiles yet — create one.</small>';
  if(selProf&&!memProfiles.some(x=>x.mem_profiles_id_pk===selProf))setSelProf(0); // stale saved id
  const sp=selProf&&memProfiles.find(x=>x.mem_profiles_id_pk===selProf)||null;
  $('profpanel').style.display=sp?'block':'none';
  if(sp)fillProf(sp);
  $('rchat').innerHTML=
    `<div class="rprof${cardId===0?' on':''}" onclick="pick(0,'${esc(roomName)}')"><div class="n">${esc(roomName)}</div><div class="m">shared memories</div></div>`;
  $('rcards').innerHTML=(cards||[]).map(c=>
      `<div class="rprof${c.id===cardId?' on':''}" onclick="pick(${c.id},'${esc(c.name).replace(/'/g,"\\'")}')"><div class="n">${esc(c.name)}</div></div>`
    ).join('')||'<small>None</small>';
  if(cardId<0)cardId=0;
  // Smart memories are room-scoped only — disable the Smart tab for character scopes.
  const smartTab=$('t_auto');
  if(smartTab){ smartTab.disabled=cardId!==0; smartTab.style.opacity=cardId!==0?'0.4':'1'; smartTab.style.cursor=cardId!==0?'not-allowed':'pointer'; }
  const {memories}=await get(`memories?card=${cardId}&room=${ROOM}`);
  allMems=memories||[];
  $('title').textContent=`${scopeName||roomName||'Memories'} — memories`;
  renderList();
}
function pick(id,name){cardId=id;scopeName=name;if(id!==0 && curTab==='smart') curTab='user';load()}
async function add(){const t=$('newmem').value.trim();if(!t)return;$('newmem').value='';await api('memories',{cardId,room:ROOM,content:t});load()}
async function toSmart(id){await api('memories/update',{id,origin:'smart'});load()}
async function del(id){if(confirm('Forget this memory?')){await api('memories/delete',{id});load()}}
let permPickId=0;
function permPick(id){permPickId=permPickId===id?0:id;renderList()}
function permPicker(m){if(permPickId!==m.id)return'';
  const cards=roomCards.map(c=>`<button onclick="moveToPerm(${m.id},${c.id})">${esc(c.name)}</button>`).join('');
  return `<div class="card" style="border-color:var(--accent)"><div class="desc">Move to permanent — pick a scope:</div><div class="btns" style="flex-direction:row;flex-wrap:wrap"><button onclick="moveToPerm(${m.id},0)">${esc(roomName||'This chat')}</button>${cards}</div></div>`}
async function moveToPerm(id,cid){const m=allMems.find(x=>x.id===id);if(!m)return;
  await api('memories',{content:m.content,type:m.type||'fact',triggers:m.triggers||'',room:ROOM,cardId:cid||0});
  await api('memories/delete',{id});permPickId=0;load()}
