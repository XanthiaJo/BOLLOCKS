// --- Smart-memory profile editor: shared by the settings page + memories page ---
/* global $, esc, api, load, memProfiles, defPrompt, defStatePrompt, updBudgetTotal */
let selProf=Number(localStorage.mp_memprof||0);
// selProf===-1 = unsaved "new profile" draft — panel opens blank, Save creates.
const BLANK_PROF={name:'',mem_every:10,mem_budget:800,mem_max:50,mem_max_fact:15,mem_max_event:15,mem_max_relationship:15,mem_max_preference:15,mem_extraction_prompt:'',mem_context_threshold:80,mem_response_length:2000,mem_gen_budget:2000,mem_unlimited:0,mem_unified:1,mem_triggers:0,mem_autotune:0,mem_refresh:1,mem_activity:0,extraction_api_profiles_id_fk:0,mem_canon_budget:800,mem_max_arcs:10,mem_arc_budget:700,arc_api_profiles_id_fk:0,mem_state:0,mem_state_every:1,mem_max_state:30,mem_state_budget:400,mem_state_prompt:'',mem_readonly:0,mem_prune_messages:0};
function toggleDefPrompt(a,id,txt){const p=$(id||'def_prompt');const show=p.style.display==='none';p.style.display=show?'block':'none';if(show)p.textContent=(txt??defPrompt)||'(built-in prompt unavailable)';a.textContent=show?'hide it':'show it';}
function setSelProf(id){selProf=id;localStorage.mp_memprof=id;}
function fillProf(p){
  $('edtitle').textContent='Edit profile: '+p.name;$('pf_name').value=p.name;
  $('set_readonly').checked=!!p.mem_readonly;
  $('set_every').value=p.mem_every||10;$('set_budget').value=p.mem_budget||800;$('set_max').value=p.mem_max||50;
  $('set_max_fact').value=p.mem_max_fact||15;$('set_max_event').value=p.mem_max_event||15;$('set_max_rel').value=p.mem_max_relationship||15;$('set_max_pref').value=p.mem_max_preference||15;
  $('set_prompt').value=p.mem_extraction_prompt||'';$('set_ctx').value=p.mem_context_threshold||80;$('set_resplen').value=p.mem_response_length||2000;
  $('set_genbudget').value=p.mem_unlimited?-1:(p.mem_gen_budget||2000);$('set_unified').checked=!!p.mem_unified;$('set_triggers').checked=!!p.mem_triggers;$('set_autotune').checked=!!p.mem_autotune;$('set_refresh').value=p.mem_refresh||1;
  $('set_activity').checked=!!p.mem_activity;
  $('set_profile').value=p.extraction_api_profiles_id_fk||0;
  // Canon = memories with no trigger keywords; this caps their prompt block.
  $('set_canonbudget').value=p.mem_canon_budget||800;
  $('set_max_arcs').value=p.mem_max_arcs||10;
  $('set_arcbudget').value=p.mem_arc_budget||700;
  $('set_state').checked=!!p.mem_state;
  $('set_state_every').value=p.mem_state_every||1;
  $('set_max_state').value=p.mem_max_state??30;
  $('set_statebudget').value=p.mem_state_budget??400;
  $('set_stateprompt').value=p.mem_state_prompt||'';
  $('set_prune_msgs').value=p.mem_prune_messages??0;
  if(typeof updBudgetTotal==='function')updBudgetTotal();
}
function selectProf(id){setSelProf(id);load()}
function cancelProf(){if(selProf>0){const p=memProfiles.find(x=>x.mem_profiles_id_pk===selProf);if(p)fillProf(p);return}fillProf(BLANK_PROF);$('edtitle').textContent='New profile'}
function rowToProf(p){return {id:p.mem_profiles_id_pk,name:p.name,every:p.mem_every||10,budget:p.mem_budget||800,max:p.mem_max||50,maxFact:p.mem_max_fact||15,maxEvent:p.mem_max_event||15,maxRel:p.mem_max_relationship||15,maxPref:p.mem_max_preference||15,extractionPrompt:p.mem_extraction_prompt||'',contextThreshold:p.mem_context_threshold||80,responseLength:p.mem_response_length||2000,profileId:p.extraction_api_profiles_id_fk||0,genBudget:p.mem_gen_budget||2000,unlimited:!!p.mem_unlimited,unified:(p.mem_unified??1)?1:0,triggers:!!p.mem_triggers,autotune:!!p.mem_autotune,refresh:p.mem_refresh||1,activity:!!p.mem_activity,canonBudget:p.mem_canon_budget||800,maxArcs:p.mem_max_arcs||10,arcBudget:p.mem_arc_budget||700,arcProfileId:p.arc_api_profiles_id_fk||0,state:!!p.mem_state,stateEvery:p.mem_state_every||1,maxState:p.mem_max_state??30,stateBudget:p.mem_state_budget??400,statePrompt:p.mem_state_prompt||'',readonly:!!p.mem_readonly,pruneMessages:p.mem_prune_messages??0}}
function collectProf(){const p=memProfiles.find(x=>x.mem_profiles_id_pk===selProf);const base=p?rowToProf(p):{name:'Profile'};const gb=Number($('set_genbudget').value)||0,unl=gb<=-1;return {...base,id:selProf,name:$('pf_name').value.trim()||base.name,extractionPrompt:$('set_prompt').value,contextThreshold:Number($('set_ctx').value)||80,responseLength:Number($('set_resplen').value)||2000,profileId:$('set_profile').value?Number($('set_profile').value):0,genBudget:unl?-1:(gb||2000),unlimited:unl?1:0,unified:$('set_unified').checked?1:0,triggers:$('set_triggers').checked?1:0,autotune:$('set_autotune').checked?1:0,refresh:Number($('set_refresh').value)||1,activity:$('set_activity').checked?1:0,every:Number($('set_every').value)||10,budget:Number($('set_budget').value)||800,max:Number($('set_max').value)||50,maxFact:Number($('set_max_fact').value)||0,maxEvent:Number($('set_max_event').value)||0,maxRel:Number($('set_max_rel').value)||0,maxPref:Number($('set_max_pref').value)||0,canonBudget:$('set_canonbudget').value===''?800:Number($('set_canonbudget').value),maxArcs:$('set_max_arcs').value===''?10:Number($('set_max_arcs').value),arcBudget:$('set_arcbudget').value===''?700:Number($('set_arcbudget').value),state:$('set_state').checked?1:0,stateEvery:Number($('set_state_every').value)||1,maxState:$('set_max_state').value===''?30:Number($('set_max_state').value),stateBudget:$('set_statebudget').value===''?400:Number($('set_statebudget').value),statePrompt:$('set_stateprompt').value,readonly:$('set_readonly').checked?1:0,pruneMessages:Number($('set_prune_msgs').value)||0}}
async function saveProf(){
  if(selProf===-1){const {id:_id,...body}=collectProf();const r=await api('memprofiles',body);setSelProf(r?.id||0);load();return;}
  if(!selProf)return;await api('memprofiles/update',collectProf());load()}
function newMP(){setSelProf(-1);load()}
async function delMP(id){if(id<=0){setSelProf(0);load();return}if(confirm('Delete this memory profile? Chats following it switch to another profile.')){if(selProf===id)setSelProf(0);await api('memprofiles/delete',{id});load()}}
// The editor splits into Extraction (writer) and Injection (reader) groups —
// each gets its own accordion state and its own "to be implemented" divider.
if(document.getElementById('pg_ext')){
  setupAcc(document.getElementById('pg_ext'),'mp_mem_acc_ext');
  setupAcc(document.getElementById('pg_inj'),'mp_mem_acc_inj');
  setupAcc(document.getElementById('pg_tbi'),'mp_mem_acc_tbi');
}else setupAcc(document.getElementById('profpanel'),'mp_mem_acc');
load();
