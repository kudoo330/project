const form=document.querySelector('#login-form'),error=document.querySelector('#login-error');
const destination=()=>'/home';
fetch('/api/me').then(async r=>{if(r.ok)location.replace(destination(await r.json()));}).catch(()=>{});
form.addEventListener('submit',async event=>{
  event.preventDefault();const button=form.querySelector('button');button.disabled=true;error.textContent='';
  try{const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(form)))});const data=await r.json();if(!r.ok)throw new Error(data.error||'登录失败');location.replace(destination(data));}
  catch(e){error.textContent=e.message||'网络连接失败，请重试';}finally{button.disabled=false;}
});
