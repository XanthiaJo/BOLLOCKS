const H=()=>({'Content-Type':'application/json','Authorization':'Bearer '+(localStorage.mp_token||'')});
const api=(p,b)=>fetch(`/api/${p}`,{method:'POST',headers:H(),body:JSON.stringify(b||{})}).then(r=>r.status===401?location='/login.html':r.json());
const get=p=>fetch(`/api/${p}`,{headers:H()}).then(r=>r.status===401?location='/login.html':r.json());
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
let me={},users=[],editId=0;

function row(u){
    if(editId===u.id) return `<div class="rprof" style="display:block">
        <div class="edhead" data-save="saveEdit" data-cancel="cancelEdit"><h3>Edit ${esc(u.handle)}</h3></div>
        <div class="row"><span class="lbl">Handle</span><input id="edhandle" value="${esc(u.handle)}" style="width:200px"></div>
        <div class="row"><span class="lbl">Email</span><input id="edemail" value="${esc(u.email)}" type="email" style="width:240px"></div>
        <div class="row"><span class="lbl">New password <small>(blank = unchanged)</small></span><input id="edpass" type="password" placeholder="leave blank to keep" style="width:200px"></div>
    </div>`;
    const soleAdmin=u.admin&&users.filter(x=>x.admin).length===1;
    return `<div class="rprof"><div class="txt"><div class="n">${esc(u.handle)}${u.admin?' <small style="color:var(--accent)">admin</small>':''}</div>
        <div class="m">${u.email?esc(u.email)+' · ':''}${u.persona_name?'persona '+esc(u.persona_name):'no persona'}</div></div>
        <div class="btns">
            <label class="cb" style="margin:0" title="${soleAdmin?'the last admin cannot be demoted':'site admin'}">
              <input type="checkbox"${u.admin?' checked':''}${soleAdmin?' disabled':''} onchange="setAdmin(${u.id},this.checked)"> admin</label>
            <button class="sec" onclick="editUser(${u.id})">Edit</button>
            ${u.admin?'':`<button class="sec" onclick="delUser(${u.id},'${esc(u.handle)}')">Delete</button>`}
        </div></div>`;
}
async function load(){
    users=(await get('admin/users')).users||[];
    $('list').innerHTML=users.map(row).join('')||'<div class="hint">no users</div>';
    initEdHeads($('list'));
}
function newUser(){$('newbox').style.display=$('newbox').style.display==='none'?'block':'none'}
function cancelNew(){$('newbox').style.display='none';for(const i of['newhandle','newemail','newpass'])$(i).value=''}
async function saveNew(){
    const handle=$('newhandle').value.trim(),password=$('newpass').value,email=$('newemail').value.trim();
    if(!handle||!password)return alert('handle and password required');
    const r=await api('register',{handle,password});
    if(r.error)return alert(r.error);
    if(email)await api('admin/users/update',{id:r.id,email});
    cancelNew();load();
}
function editUser(id){editId=id;load()}
async function setAdmin(id,v){
    const r=await api('admin/users/update',{id,admin:v});
    if(r.error)alert(r.error); // e.g. demoting the only admin — server refuses
    load();
}
function cancelEdit(){editId=0;load()}
async function saveEdit(){
    const u=users.find(x=>x.id===editId);if(!u)return;
    const r=await api('admin/users/update',{id:u.id,handle:$('edhandle').value,email:$('edemail').value});
    if(r.error)return alert(r.error);
    const p=$('edpass').value;
    if(p){const r2=await api('admin/users/password',{id:u.id,password:p});if(r2.error)return alert(r2.error)}
    editId=0;load();
}
async function delUser(id,handle){
    if(!confirm(`Delete ${handle}? Their cards, rooms, profiles and sessions all go with them.`))return;
    const r=await api('users/delete',{id});
    if(r.error)return alert(r.error);
    load();
}
(async()=>{
    me=await get('me');
    if(!me?.admin){location='/';return}
    load();
})();
