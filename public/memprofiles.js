// --- Smart-memory profile editor: shared by the settings page + memories page ---
/* global $, esc, api, load, ROOM, memProfiles, defPrompt */
let selProf=Number(localStorage.mp_memprof||0);
// selProf===-1 = unsaved "new profile" draft — panel opens blank, Save creates.
const BLANK_PROF={name:'',auto_mem:0,mem_every:10,mem_budget:800,mem_max:50,mem_max_fact:15,mem_max_event:15,mem_max_relationship:15,mem_max_preference:15,mem_extraction_prompt:'',mem_context_threshold:80,mem_response_length:2000,mem_gen_budget:2000,mem_unlimited:0,mem_unified:1,mem_triggers:0,mem_autotune:0,mem_refresh:1,mem_activity:0,mem_extraction_profile_id:0};
function toggleDefPrompt(a){const p=$('def_prompt');const show=p.style.display==='none';p.style.display=show?'block':'none';if(show)p.textContent=defPrompt||'(built-in prompt unavailable)';a.textContent=show?'hide it':'show it';}
function setSelProf(id){selProf=id;localStorage.mp_memprof=id;}
function fillProf(p){
  $('edtitle').textContent='Edit profile: '+p.name;$('pf_name').value=p.name;
  $('set_every').value=p.mem_every||10;$('set_budget').value=p.mem_budget||800;$('set_max').value=p.mem_max||50;
  $('set_max_fact').value=p.mem_max_fact||15;$('set_max_event').value=p.mem_max_event||15;$('set_max_rel').value=p.mem_max_relationship||15;$('set_max_pref').value=p.mem_max_preference||15;
  $('set_prompt').value=p.mem_extraction_prompt||'';$('set_ctx').value=p.mem_context_threshold||80;$('set_resplen').value=p.mem_response_length||2000;
  $('set_genbudget').value=p.mem_unlimited?-1:(p.mem_gen_budget||2000);$('set_unified').checked=!!p.mem_unified;$('set_triggers').checked=!!p.mem_triggers;$('set_autotune').checked=!!p.mem_autotune;$('set_refresh').value=p.mem_refresh||1;
  $('set_activity').checked=!!p.mem_activity;
  $('set_profile').value=p.mem_extraction_profile_id||0;
}
function selectProf(id){setSelProf(id);load()}
function cancelProf(){if(selProf>0){const p=memProfiles.find(x=>x.mem_profiles_id_pk===selProf);if(p)fillProf(p);return}setSelProf(0);load()}
function rowToProf(p){return {id:p.mem_profiles_id_pk,name:p.name,auto:!!p.auto_mem,every:p.mem_every||10,budget:p.mem_budget||800,max:p.mem_max||50,maxFact:p.mem_max_fact||15,maxEvent:p.mem_max_event||15,maxRel:p.mem_max_relationship||15,maxPref:p.mem_max_preference||15,extractionPrompt:p.mem_extraction_prompt||'',contextThreshold:p.mem_context_threshold||80,responseLength:p.mem_response_length||2000,profileId:p.mem_extraction_profile_id||0,genBudget:p.mem_gen_budget||2000,unlimited:!!p.mem_unlimited,unified:(p.mem_unified??1)?1:0,triggers:!!p.mem_triggers,autotune:!!p.mem_autotune,refresh:p.mem_refresh||1,activity:!!p.mem_activity}}
function collectProf(){const p=memProfiles.find(x=>x.mem_profiles_id_pk===selProf);const base=p?rowToProf(p):{name:'Profile'};const gb=Number($('set_genbudget').value)||0,unl=gb<=-1;return {...base,id:selProf,name:$('pf_name').value.trim()||base.name,extractionPrompt:$('set_prompt').value,contextThreshold:Number($('set_ctx').value)||80,responseLength:Number($('set_resplen').value)||2000,profileId:$('set_profile').value?Number($('set_profile').value):0,genBudget:unl?-1:(gb||2000),unlimited:unl?1:0,unified:$('set_unified').checked?1:0,triggers:$('set_triggers').checked?1:0,autotune:$('set_autotune').checked?1:0,refresh:Number($('set_refresh').value)||1,activity:$('set_activity').checked?1:0,every:Number($('set_every').value)||10,budget:Number($('set_budget').value)||800,max:Number($('set_max').value)||50,maxFact:Number($('set_max_fact').value)||0,maxEvent:Number($('set_max_event').value)||0,maxRel:Number($('set_max_rel').value)||0,maxPref:Number($('set_max_pref').value)||0}}
async function saveProf(){
  if(selProf===-1){const {id:_id,...body}=collectProf();const r=await api('memprofiles',body);setSelProf(r?.id||0);load();return;}
  if(!selProf)return;await api('memprofiles/update',collectProf());load()}
function newMP(){setSelProf(-1);load()}
async function delMP(id){if(id<=0){setSelProf(0);load();return}if(confirm('Delete this memory profile? Chats following it switch to another profile.')){if(selProf===id)setSelProf(0);await api('memprofiles/delete',{id});load()}}
function setupAcc(){
  const panel=document.getElementById('profpanel');
  if(!panel) return;
  let openSet=new Set(); try{ openSet=new Set(JSON.parse(localStorage.mp_mem_acc||'[]')); }catch{}
  const saveAcc=()=>{ localStorage.mp_mem_acc=JSON.stringify([...panel.querySelectorAll('.acc-h.open')].map(h=>h.dataset.acc)); };
  const h4s=[...panel.querySelectorAll('h4')];
  for(const h of h4s){
    const wrap=document.createElement('div'); wrap.className='acc';
    const header=document.createElement('div'); header.className='acc-h';
    header.dataset.acc=h.textContent.trim();
    const title=document.createElement('div'); title.className='acc-t';
    title.innerHTML=esc(h.textContent);
    const arrow=document.createElement('span'); arrow.className='arrow'; arrow.textContent='▸';
    header.append(title,arrow);
    const body=document.createElement('div'); body.className='acc-b';
    let node=h.nextSibling; const toMove=[];
    while(node && !(node.nodeType===1 && node.tagName==='H4')){ toMove.push(node); node=node.nextSibling; }
    h.parentNode.insertBefore(wrap,h);
    wrap.appendChild(header); wrap.appendChild(body);
    for(const n of toMove) body.appendChild(n);
    // An intro caption (a hint immediately after the h4) belongs on the
    // header so it shows even while the section is collapsed.
    if(body.firstElementChild?.classList.contains('hint')) title.append(body.firstElementChild);
    // Sections where every control is disabled are placeholders — say so.
    if(!title.querySelector('.hint') && !body.querySelector('input:not([disabled]),select:not([disabled]),textarea:not([disabled])')){
      const note=document.createElement('span'); note.className='hint';
      note.textContent='Not implemented yet — these are placeholders for planned features.';
      title.append(note);
    }
    h.remove();
    if(openSet.has(header.dataset.acc)){ header.classList.add('open'); body.classList.add('open'); }
    header.onclick=()=>{ header.classList.toggle('open'); body.classList.toggle('open'); saveAcc(); };
  }
}
setupAcc();
load();
