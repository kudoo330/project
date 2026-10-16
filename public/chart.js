const ns='http://www.w3.org/2000/svg';
function element(tag,attrs={},text){const e=document.createElementNS(ns,tag);for(const[k,v]of Object.entries(attrs))e.setAttribute(k,v);if(text!==undefined)e.textContent=text;return e;}
export function chart(container,series,labels){
  const colors=['#25776c','#b97849','#6977ad','#b25d78','#6d8d4c'],svg=element('svg',{viewBox:'0 0 800 260',class:'chart',role:'img','aria-label':'价格走势，数值可在下方明细表中查看'});
  const values=series.flatMap(s=>s.values.filter(v=>v!==null&&Number.isFinite(v)));if(!values.length){container.textContent='暂无可绘制的有效价格';return;}
  let min=Math.min(...values),max=Math.max(...values);if(max===min){max+=1;min-=1;}const pad=(max-min)*.12;min-=pad;max+=pad;
  const x=i=>55+i/Math.max(1,labels.length-1)*720,y=v=>220-(v-min)/(max-min)*190;
  for(let i=0;i<=4;i++){const v=min+(max-min)*i/4;svg.append(element('line',{x1:55,y1:y(v),x2:775,y2:y(v),class:'grid'}));svg.append(element('text',{x:3,y:y(v)+4},v.toFixed(2)));}
  for(const i of [...new Set([0,Math.floor((labels.length-1)/2),labels.length-1])])svg.append(element('text',{x:x(i),y:246,'text-anchor':'middle'},labels[i]??''));
  const legend=document.createElement('div');legend.className='legend';
  series.forEach((s,index)=>{
    let path='';s.values.forEach((v,i)=>{if(v===null||!Number.isFinite(v)){path+=' ';return;}path+=(i===0||s.values[i-1]===null?'M':'L')+x(i)+','+y(v)+' ';});
    const line=element('path',{d:path,fill:'none',stroke:colors[index%colors.length],'stroke-width':2});svg.append(line);
    s.values.forEach((v,i)=>{if(v===null||!Number.isFinite(v))return;const dot=element('circle',{cx:x(i),cy:y(v),r:2,fill:colors[index%colors.length]});dot.append(element('title',{},`${s.name} · ${labels[i]}：${v.toFixed(3)}`));svg.append(dot);});
    const label=document.createElement('span');label.textContent=s.name;legend.append(label);
  });
  container.replaceChildren(svg,legend);
}
