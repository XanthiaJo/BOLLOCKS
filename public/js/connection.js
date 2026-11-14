const H=()=>({'Content-Type':'application/json','Authorization':'Bearer '+(localStorage.mp_token||'')});
const api=(p,b)=>fetch(`/api/${p}`,{method:'POST',headers:H(),body:JSON.stringify(b||{})}).then(r=>r.status===401?location='/login.html':r.json());
const get=p=>fetch(`/api/${p}`,{headers:H()}).then(r=>r.status===401?location='/login.html':r.json());
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

// Two profile kinds share this page: 'api' = connection profiles (endpoint,
// model, key), 'inj' = injection profiles (prompt assembly). The tab swaps
// which list the sidebar shows and which editor opens.
initSidebar({
  tabs:[{id:'t_api',label:'Connection',on:true,onclick:"connTab('api')"},{id:'t_inj',label:'Injection',onclick:"connTab('inj')"}],
  sections:[{title:'Profiles',id:'list'}],
  buttons:[{label:'+ New profile',onclick:'newProf()'}],
});
let curTab=localStorage.mp_conntab||'api';
let allProfs=[],injProfs=[],promptBlocks=[],orderKeys=[];
function connTab(t){curTab=t;localStorage.mp_conntab=t;load();newProf()}

async function load(){
  $('t_api').classList.toggle('on',curTab==='api');
  $('t_inj').classList.toggle('on',curTab==='inj');
  $('cvtitle').textContent=curTab==='inj'?'Injection':'Connection';
  if(curTab==='inj'){
    const r=await get('promptprofiles');injProfs=r?.profiles||[];promptBlocks=r?.promptBlocks||[];
    $('list').innerHTML=injProfs.map(p=>rprofRow({
      name:`${esc(p.name)}${p.active?'<span class="badge">active</span>':''}`,
      meta:p.prompt_order?'custom order':'built-in order',
      onclick:`editInj(${p.prompt_profiles_id_pk})`,
      btns:`${p.active?'':`<button class="act" onclick="activate(${p.prompt_profiles_id_pk})">Make active</button>`}<button class="del" onclick="del(${p.prompt_profiles_id_pk})">Delete</button>`,
    })).join('')||'<small>No injection profiles yet.</small>';
  } else {
    const {profiles}=await get('profiles');allProfs=profiles||[];
    $('list').innerHTML=allProfs.map(p=>rprofRow({
      name:`${esc(p.name)}${p.active?'<span class="badge">active</span>':''}`,
      meta:`${esc(p.api_url)} · ${esc(p.model)} · ${p.has_key?'key set':'no key'}`,
      onclick:`edit(${p.id})`,
      btns:`${p.active?'':`<button class="act" onclick="activate(${p.id})">Make active</button>`}<button class="del" onclick="del(${p.id})">Delete</button>`,
    })).join('')||'<small>No profiles yet.</small>';
  }
}

function showEd(id){$('editor').style.display=id==='editor'?'block':'none';$('injeditor').style.display=id==='injeditor'?'block':'none';mpScrollTo($(id))}

function edit(id){const p=allProfs.find(x=>x.id===id);if(!p)return;
  document.querySelectorAll('.prof').forEach(el=>el.classList.remove('sel'));
  $('edtitle').textContent='Edit '+p.name;$('ed_id').value=p.id;$('ed_name').value=p.name;$('ed_url').value=p.api_url;$('ed_model').value=p.model;$('ed_key').value='';$('ed_headers').value=p.headers&&p.headers!=='{}'?p.headers:'';$('ed_ctx').value=p.context_size||0;$('ed_maxr').value=p.max_response||2048;
  showEd('editor')}
function editInj(id){const p=injProfs.find(x=>x.prompt_profiles_id_pk===id);if(!p)return;
  $('injtitle').textContent='Edit '+p.name;$('inj_id').value=id;$('inj_name').value=p.name;$('inj_time').checked=!!p.include_time;
  orderKeys=orderFrom(p.prompt_order);renderOrder();
  showEd('injeditor')}

// Prompt-order list: stored order wins; unknown keys dropped, missing keys
// appended so new blocks can't silently vanish from the prompt.
function orderFrom(raw){const keys=promptBlocks.map(b=>b.key);let a=null;try{a=JSON.parse(raw)}catch{}
  if(!Array.isArray(a))return keys;
  a=a.filter(k=>keys.includes(k));
  return [...a,...keys.filter(k=>!a.includes(k))];}
const openBlocks=new Set();
function toggleBlock(k){openBlocks.has(k)?openBlocks.delete(k):openBlocks.add(k);renderOrder()}
function renderOrder(){const el=$('order_list');if(!el)return;
  el.innerHTML=orderKeys.map((k,i)=>{const b=promptBlocks.find(x=>x.key===k);const open=openBlocks.has(k);
    return `<li style="padding:2px 4px 2px 8px;background:var(--input);border-radius:4px;margin-bottom:3px"><div style="display:flex;align-items:center;gap:6px">`+
      `<span style="flex:1;font-size:.9em;cursor:pointer" onclick="toggleBlock('${k}')">${open?'▾':'▸'} ${b?b.label:k}</span>`+
      `<button onclick="moveOrder(${i},-1)"${i?'':' disabled'}>&uarr;</button>`+
      `<button onclick="moveOrder(${i},1)"${i<orderKeys.length-1?'':' disabled'}>&darr;</button></div>`+
      (open?`<pre style="margin:4px 0 2px;padding-left:6px;border-left:2px solid var(--line2);font-size:.78em;color:var(--dim);white-space:pre-wrap">${esc(b?.example||'(no example)')}</pre>`:'')+
      `</li>`}).join('')}
function moveOrder(i,d){const j=i+d;if(j<0||j>=orderKeys.length)return;
  [orderKeys[i],orderKeys[j]]=[orderKeys[j],orderKeys[i]];renderOrder()}

async function fetchModels(){
  const r=await api('models',{profileId:$('ed_id').value?Number($('ed_id').value):null,
    apiUrl:$('ed_url').value.trim(),key:$('ed_key').value.trim(),headers:$('ed_headers').value.trim()||'{}'});
  if(r.error)return alert(r.error);
  $('modelist').innerHTML=(r.models||[]).map(m=>`<option value="${m}">`).join('');
  $('ed_model').focus();
}
function clearEd(){
  $('edtitle').textContent='New profile';$('ed_id').value='';$('ed_name').value='';$('ed_url').value='';$('ed_model').value='';$('ed_key').value='';$('ed_headers').value='';$('ed_ctx').value='';$('ed_maxr').value='';
  $('injtitle').textContent='New injection profile';$('inj_id').value='';$('inj_name').value='';$('inj_time').checked=false;orderKeys=orderFrom(null);renderOrder();
}
function newProf(){clearEd();showEd(curTab==='inj'?'injeditor':'editor');$(curTab==='inj'?'inj_name':'ed_name').focus()}
function cancelEd(){const inj=curTab==='inj';const id=Number($(inj?'inj_id':'ed_id').value)||0;if(!id)return clearEd();inj?editInj(id):edit(id)}

async function saveProf(){
  if(curTab==='inj'){
    const id=Number($('inj_id').value)||0;
    const b={name:$('inj_name').value.trim(),order:orderKeys,includeTime:$('inj_time').checked?1:0};
    if(!b.name)return alert('needs a name');
    if(id)await api('promptprofiles/update',{id,...b});
    else await api('promptprofiles',b);
    if(!id)clearEd();
    mpFlashSaved();load();return;
  }
  const id=$('ed_id').value;
  const b={name:$('ed_name').value.trim(),apiUrl:$('ed_url').value.trim(),model:$('ed_model').value.trim(),key:$('ed_key').value.trim(),headers:$('ed_headers').value.trim()||'{}',contextSize:Number($('ed_ctx').value)||0,maxResponse:Number($('ed_maxr').value)||2048};
  if(b.headers!=='{}'){
    try{JSON.parse(b.headers)}
    catch{
      // Accept "name: value" lines and convert to JSON
      const h={};
      for(const line of b.headers.split(/[\n,]+/)){const i=line.indexOf(':');if(i<1)return alert('Headers must be JSON or "name: value" lines');h[line.slice(0,i).trim()]=line.slice(i+1).trim();}
      b.headers=JSON.stringify(h);
    }
  }
  if(!b.name)return alert('needs a name');
  if(id)await api('profiles/update',{id:Number(id),...b});
  else await api('profiles',b);
  if(!id)clearEd();
  mpFlashSaved();load();
}
async function activate(id){await api(curTab==='inj'?'promptprofiles/activate':'profiles/activate',{id});load()}
async function del(id){if(confirm('Delete this profile?')){await api(curTab==='inj'?'promptprofiles/delete':'profiles/delete',{id});load()}}
load().then(newProf);
