// --- Memory settings page: profile list in the sidebar, editor in main ---
/* global selProf, setSelProf, fillProf, BLANK_PROF, newMP, delMP, selectProf */
let booted=false;
const H=()=>({'Content-Type':'application/json','Authorization':'Bearer '+(localStorage.mp_token||'')});
const api=(p,b)=>fetch(`/api/${p}`,{method:'POST',headers:H(),body:JSON.stringify(b||{})}).then(r=>r.status===401?location='/login.html':r.json());
const get=p=>fetch(`/api/${p}`,{headers:H()}).then(r=>r.status===401?location='/login.html':r.json());
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
initSidebar({
  tabs:[{label:'Smart memory profiles',on:true,onclick:'newMP()'}],
  sections:[{title:'Smart memory profiles',id:'plist'}],
  buttons:[{label:'+ New profile',onclick:'newMP()'}],
  footer:'Chats pick which smart-memory profile they follow in their chat settings or the <a href="/memories.html" style="color:var(--muted)">Memories</a> page\'s Smart tab. Select a profile to edit it.',
});
let memProfiles=[];let defPrompt='';
async function load(){
  const [{profiles},mps]=await Promise.all([get('profiles'),get('memprofiles')]);
  memProfiles=mps?.profiles||[];defPrompt=mps?.defaultPrompt||'';
  const profOpts='<option value="0">— none (extraction off) —</option>'+(profiles||[]).map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join('');
  $('set_profile').innerHTML=profOpts;
  $('plist').innerHTML=(memProfiles||[]).map(p=>
    rprofRow({name:esc(p.name),
      sel:p.mem_profiles_id_pk===selProf,
      onclick:`selectProf(${p.mem_profiles_id_pk})`,
      btns:`<button class="del" onclick="delMP(${p.mem_profiles_id_pk})">Delete</button>`})).join('')||'<small>No profiles yet — create one.</small>';
  if(selProf>0&&!memProfiles.some(x=>x.mem_profiles_id_pk===selProf))setSelProf(0); // stale saved id
  const sp=selProf>0&&memProfiles.find(x=>x.mem_profiles_id_pk===selProf)||null;
  $('profpanel').style.display=(sp||selProf===-1)?'block':'none';
  if(sp)fillProf(sp);else if(selProf===-1){fillProf(BLANK_PROF);$('edtitle').textContent='New profile';}
  if(!booted){booted=true;if(!selProf)newMP();} // landing on the page opens the new form
}
