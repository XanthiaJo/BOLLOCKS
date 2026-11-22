// --- Memory profiles page: presets a chat's memory-writer follows ---
/* global selProf, setSelProf, fillProf, BLANK_PROF, newMP, delMP, selectProf */
let booted=false;
const H=()=>({'Content-Type':'application/json','Authorization':'Bearer '+(localStorage.mp_token||'')});
const api=(p,b)=>fetch(`/api/${p}`,{method:'POST',headers:H(),body:JSON.stringify(b||{})}).then(r=>r.status===401?location='/login.html':r.json());
const get=p=>fetch(`/api/${p}`,{headers:H()}).then(r=>r.status===401?location='/login.html':r.json());
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
initSidebar({
  tabs:[{label:'Memory profiles',on:true,onclick:'newMP()'}],
  sections:[{title:'Memory profiles',id:'plist'}],
  buttons:[{label:'+ New profile',onclick:'newMP()'}],
  footer:'Profiles preset how the memory-writer runs — a chat follows one; create and edit them here.',
});
let memProfiles=[];let defPrompt='';let defStatePrompt='';
async function load(){
  const [{profiles},mps]=await Promise.all([get('profiles'),get('memprofiles')]);
  memProfiles=mps?.profiles||[];defPrompt=mps?.defaultPrompt||'';defStatePrompt=mps?.defaultStatePrompt||'';
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
// Budgets accordion: running total of the enabled per-turn injection caps.
// A row's data-enable names the control that gates it (checkbox, or any
// number/select where 0/empty means off) — gated-off rows dim and drop out.
function updBudgetTotal(){
  const t=$('budget_total');if(!t)return;
  const num=id=>Number($(id)?.value)||0;
  let peak=0;
  for(const row of document.querySelectorAll('#budgets .row')){
    const inp=row.querySelector('input[type=number]:not([disabled])');
    if(!inp)continue;
    const ctl=row.dataset.enable&&$(row.dataset.enable);
    const on=!ctl||(ctl.type==='checkbox'?ctl.checked:Number(ctl.value)>0);
    row.classList.toggle('boff',!on);
    if(on)peak+=Number(inp.value)||0;
  }
  t.textContent=Math.max(0,peak);
  const a=$('budget_avg');
  if(a){
    const refresh=Math.max(1,num('set_refresh'));
    const mem=$('set_budget')?.closest('.row').classList.contains('boff')?0:num('set_budget');
    a.textContent=Math.max(0,Math.round(peak-mem+mem/refresh));
  }
}
$('profpanel').addEventListener('input',updBudgetTotal);
