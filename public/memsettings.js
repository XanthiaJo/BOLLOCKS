// --- Memory settings page: profile list in the sidebar, editor in main ---
/* global selProf, effRow, setSelProf, fillProf */
const H=()=>({'Content-Type':'application/json','Authorization':'Bearer '+(localStorage.mp_token||'')});
const api=(p,b)=>fetch(`/api/${p}`,{method:'POST',headers:H(),body:JSON.stringify(b||{})}).then(r=>r.status===401?location='/login.html':r.json());
const get=p=>fetch(`/api/${p}`,{headers:H()}).then(r=>r.status===401?location='/login.html':r.json());
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
let ROOM=Number(localStorage.mp_room||1);
let memProfiles=[];let defPrompt='';
async function load(){
  const [{profiles},{rooms},mps]=await Promise.all([get('profiles'),get('rooms'),get('memprofiles')]);
  memProfiles=mps?.profiles||[];defPrompt=mps?.defaultPrompt||'';
  const profOpts='<option value="0">— none (extraction off) —</option>'+(profiles||[]).map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join('');
  $('set_profile').innerHTML=profOpts;
  // What "current" means for Save-current-as-profile: the profile this chat follows.
  const rm=(rooms||[]).find(r=>r.id===ROOM);
  const followed=(rm?.mem_profiles_id_fk)&&(memProfiles.find(x=>x.mem_profiles_id_pk===rm.mem_profiles_id_fk))||null;
  effRow=followed||memProfiles[0]||null;
  $('plist').innerHTML=(memProfiles||[]).map(p=>
    `<div class="rprof${p.mem_profiles_id_pk===followed?.mem_profiles_id_pk?' on':''}${p.mem_profiles_id_pk===selProf?' sel':''}" onclick="selectProf(${p.mem_profiles_id_pk})"><div class="txt"><div class="n">${esc(p.name)}${p.auto_mem?' <span class="badge">smart on</span>':''}</div></div><div class="btns" onclick="event.stopPropagation()"><button class="del" onclick="delMP(${p.mem_profiles_id_pk})">Delete</button></div></div>`).join('')||'<small>No profiles yet — create one.</small>';
  if(selProf&&!memProfiles.some(x=>x.mem_profiles_id_pk===selProf))setSelProf(0); // stale saved id
  const sp=selProf&&memProfiles.find(x=>x.mem_profiles_id_pk===selProf)||null;
  $('profpanel').style.display=sp?'block':'none';
  if(sp)fillProf(sp);
}
