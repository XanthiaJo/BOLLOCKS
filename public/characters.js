const H=()=>({'Content-Type':'application/json','Authorization':'Bearer '+(localStorage.mp_token||'')});
const api=(p,b)=>fetch(`/api/${p}`,{method:'POST',headers:H(),body:JSON.stringify(b||{})}).then(r=>r.status===401?location='/login.html':r.json());
const get=p=>fetch(`/api/${p}`,{headers:H()}).then(r=>r.status===401?location='/login.html':r.json());
const $=id=>document.getElementById(id);
// Crop-drag wiring
document.addEventListener('DOMContentLoaded',()=>{
  const box=$('cropbox');let drag=null;
  const mv=e=>{
    if(!drag)return;const p=e.touches?e.touches[0]:e;
    cropX=Math.max(0,Math.min($('cropimg').width-cropSize,p.clientX-drag.x));
    cropY=Math.max(0,Math.min($('cropimg').height-cropSize,p.clientY-drag.y));
    box.style.left=cropX+'px';box.style.top=cropY+'px';
  };
  const dn=e=>{const p=e.touches?e.touches[0]:e;const r=box.getBoundingClientRect();drag={x:p.clientX-cropX,y:p.clientY-cropY};e.preventDefault();};
  box.addEventListener('mousedown',dn);box.addEventListener('touchstart',dn);
  document.addEventListener('mousemove',mv);document.addEventListener('touchmove',mv);
  document.addEventListener('mouseup',()=>drag=null);document.addEventListener('touchend',()=>drag=null);
});

initSidebar({tabs:[{label:'Characters',on:true,onclick:'newCard()'}],sections:[{title:'Characters',id:'list'}],buttons:[{label:'+ New character',onclick:'newCard()'}]});
let me='',allCards=[];
async function load(){
  const [{cards},who]=await Promise.all([get('cards'),get('me')]);
  me=who.handle;allCards=cards||[];
  $('list').innerHTML=allCards.map((c,i)=>rprofRow({
      img:`<img src="/api/avatar?id=${c.id}" onerror="this.style.visibility='hidden'">`,
      name:esc(c.name),meta:`#${c.id} · ${esc(c.owner||'?')}${profName(c)}`,onclick:`editIdx(${i})`,
      btns:`${c.owner===me?`<button class="${c.is_persona?'act':'sec'}" onclick="api('persona',{cardId:${c.is_persona?'null':c.id}}).then(load)">★${c.is_persona?' persona':''}</button>`:''}` +
        `${c.owner===me?`<button class="del" onclick="del(${c.id})">Delete</button>`:''}`,
    })).join('');
}
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
let profs=[];
const profName=c=>c.api_profiles_id_fk?(' · '+(profs.find(p=>p.id===c.api_profiles_id_fk)?.name||'custom api')):'';
async function loadProfs(){
  const {profiles}=await get('profiles');
  profs=profiles||[];
  $('ed_profile').innerHTML='<option value="">� default �</option>'+
    profs.map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join('');
}

function editIdx(i){edit(allCards[i])}
function edit(c){
  const mine=c.owner===me;
  document.querySelectorAll('#editor input:not([type=hidden]),#editor textarea,#editor select,#editor button').forEach(el=>el.disabled=!mine);
  $('edtitle').textContent=(mine?'Edit ':'')+c.name+(mine?'':` (${c.owner})`);
  $('ed_av').src=c.avatar?'/api/avatar?id='+c.id+'&t='+Date.now():'';
  if(!mine){$('ed_id').value=c.id;$('ed_name').value=c.name;$('ed_desc').value=c.description;$('ed_personality').value=c.personality||'';$('ed_scenario').value=c.scenario||'';$('ed_first').value=c.first_message||'';$('ed_mesex').value=c.mes_example||'';$('ed_sysp').value=c.system_prompt||'';$('ed_phi').value=c.post_history_instructions||'';$('ed_tags').value=JSON.parse(c.tags||'[]').join(', ');mpOpenEditor('inline');return;}$('edtitle').textContent='Edit '+c.name;$('ed_id').value=c.id;$('ed_name').value=c.name;$('ed_desc').value=c.description;$('ed_personality').value=c.personality||'';$('ed_scenario').value=c.scenario||'';$('ed_first').value=c.first_message||'';$('ed_mesex').value=c.mes_example||'';$('ed_sysp').value=c.system_prompt||'';$('ed_phi').value=c.post_history_instructions||'';$('ed_tags').value=JSON.parse(c.tags||'[]').join(', ');$('ed_creator').value=c.creator||'';$('ed_profile').value=c.api_profiles_id_fk||'';mpOpenEditor('inline')}
let cropImg=null,cropX=0,cropY=0,cropSize=0,cropScale=1;
function pickAvatar(inp){
  const f=inp.files[0];inp.value='';if(!f)return;
  const img=new Image();
  img.onerror=()=>alert('Could not read that image — HEIC phone photos are not supported, save as JPG or PNG first');
  img.onload=()=>{cropImg=img;openCrop(img);};
  img.src=URL.createObjectURL(f);
}
function openCrop(img){
  const MAXD=400;cropScale=Math.min(1,MAXD/Math.max(img.width,img.height));
  $('cropimg').src=img.src;$('cropimg').width=img.width*cropScale;$('cropimg').height=img.height*cropScale;
  cropSize=Math.min($('cropimg').width,$('cropimg').height)*0.9;cropX=cropY=0;
  const box=$('cropbox');box.style.width=box.style.height=cropSize+'px';box.style.left=box.style.top='0px';
  $('cropmodal').style.display='flex';
}
function cropResize(pct){
  const maxS=Math.min($('cropimg').width,$('cropimg').height);
  cropSize=maxS*pct/100;
  cropX=Math.max(0,Math.min($('cropimg').width-cropSize,cropX));
  cropY=Math.max(0,Math.min($('cropimg').height-cropSize,cropY));
  const box=$('cropbox');box.style.width=box.style.height=cropSize+'px';box.style.left=cropX+'px';box.style.top=cropY+'px';
}
function cropConfirm(){
  const sx=cropX/cropScale,sy=cropY/cropScale,ss=cropSize/cropScale;
  const cv=document.createElement('canvas');cv.width=cv.height=512;
  cv.getContext('2d').drawImage(cropImg,sx,sy,ss,ss,0,0,512,512);
  const url=cv.toDataURL('image/png'),b64=url.split(',')[1],id=$('ed_id').value;
  $('cropmodal').style.display='none';
  if(id)api('cards/avatar',{id:Number(id),png_b64:b64}).then(r=>{
    if(r.error)alert(r.error);else $('ed_av').src='/api/avatar?id='+id+'&t='+Date.now();});
  else{$('ed_av').src=url;$('ed_av').dataset.pending=b64;}
}
function clearEd(){$('edtitle').textContent='New character';['ed_id','ed_name','ed_desc','ed_personality','ed_scenario','ed_first','ed_mesex','ed_sysp','ed_phi','ed_tags','ed_creator'].forEach(i=>$(i).value='');$('ed_profile').value='';$('ed_av').src='';$('ed_av').dataset.pending=''}
function cancelEd(){const id=Number($('ed_id').value)||0;const c=id?allCards.find(c=>c.id===id):null;if(c){edit(c);return}clearEd();$('editor').style.display='none'}
function newCard(){clearEd();document.querySelectorAll('#editor input:not([type=hidden]),#editor textarea,#editor select,#editor button').forEach(el=>el.disabled=false);mpOpenEditor('inline')}

async function saveCard(){
  const id=$('ed_id').value;
  const b={name:$('ed_name').value.trim(),description:$('ed_desc').value,personality:$('ed_personality').value,scenario:$('ed_scenario').value,first_message:$('ed_first').value,mes_example:$('ed_mesex').value,system_prompt:$('ed_sysp').value,post_history_instructions:$('ed_phi').value,tags:$('ed_tags').value,creator:me,profileId:Number($('ed_profile').value)||null};
  if(!b.name)return alert('needs a name');
  if(id)await api('cards/update',{id:Number(id),...b});
  else await api('cards',b);
  if(!id)clearEd();
  mpFlashSaved();load();
}
async function del(id){if(confirm('Delete this character?')){await api('cards/delete',{id});load()}}
async function addToRoom(id){await api('members',{room:Number(localStorage.mp_room||1),cardId:id});alert('added to current chat')}

async function importCard(input){
  const f=input.files[0];input.value='';
  if(!f)return;
  let r;
  if(f.name.endsWith('.json')){
    r=await api('cards/import',{card:await f.text()});
  }else{
    const b64=await new Promise(res=>{const fr=new FileReader();fr.onload=()=>res(fr.result.split(',')[1]);fr.readAsDataURL(f)});
    r=await api('cards/import',{png_b64:b64});
  }
  if(r.error)return alert(r.error);
  alert('imported '+r.name);load();
}
Promise.all([load(),loadProfs()]).then(newCard);

