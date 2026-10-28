/** Per-tab UI preferences only. Quotes, snapshots and credentials stay on the server. */
export function workspaceState(page,username){
 const key='tracker:workspace:'+encodeURIComponent(username)+':'+page+':v1';
 return {load(){try{const raw=sessionStorage.getItem(key);if(!raw||raw.length>100000)return null;const value=JSON.parse(raw);return value&&typeof value==='object'&&!Array.isArray(value)?value:null;}catch{return null;}},save(value){try{const raw=JSON.stringify(value);if(raw.length<=100000)sessionStorage.setItem(key,raw);}catch{}}};
}
export function captureFields(ids,names=[]){
 const values={},checks={};
 for(const id of ids){const el=document.getElementById(id);if(el)values[id]=el.type==='checkbox'?el.checked:el.value;}
 for(const name of names)checks[name]=[...document.querySelectorAll(`input[name="${name}"]:checked`)].map(el=>el.value);
 return {values,checks};
}
export function restoreFields(saved,ids,names=[]){
 if(!saved||typeof saved!=='object')return;
 for(const id of ids){const el=document.getElementById(id),value=saved.values?.[id];if(!el||value===undefined)continue;if(el.type==='checkbox'){if(typeof value==='boolean')el.checked=value;}else if(typeof value==='string'&&(el.tagName!=='SELECT'||[...el.options].some(o=>o.value===value)))el.value=value;}
 for(const name of names)if(Array.isArray(saved.checks?.[name]))for(const el of document.querySelectorAll(`input[name="${name}"]`))el.checked=saved.checks[name].includes(el.value);
}
