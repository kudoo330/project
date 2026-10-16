const form=document.querySelector('#password-form'),out=document.querySelector('#password-hash'),error=document.querySelector('#password-error'),copy=document.querySelector('#copy-hash');
form.addEventListener('submit',async event=>{
  event.preventDefault();const button=form.querySelector('button');button.disabled=true;error.textContent='';out.value='';copy.disabled=true;
  try{
    const data=new FormData(form),password=data.get('password');if(password.length<12||password.length>256||password!==data.get('confirm'))throw new Error('密码须12至256位，且两次输入相同');
    const hex=a=>[...new Uint8Array(a)].map(n=>n.toString(16).padStart(2,'0')).join(''),salt=hex(crypto.getRandomValues(new Uint8Array(16)).buffer),encoder=new TextEncoder();
    const key=await crypto.subtle.importKey('raw',encoder.encode(password),'PBKDF2',false,['deriveBits']);
    const hash=hex(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:encoder.encode(salt),iterations:100000},key,256));
    out.value=`pbkdf2$100000$${salt}$${hash}`;form.reset();copy.disabled=false;
  }catch(e){error.textContent=e.message||'生成失败，请在HTTPS页面使用现代浏览器';}finally{button.disabled=false;}
});
copy.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(out.value);error.textContent='已复制，请在Cloudflare设置中保存为Secret。';}catch{out.focus();out.select();error.textContent='请按 Ctrl+C 复制。';}});
