/** Shared by the Worker and browser; selection happens before checking price availability. */
export function normalizeAnalysisRule(value={}) {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('分析范围格式错误');
  const first=value.first_n??null,time=value.before_time??null;
  if(first!==null&&(!Number.isInteger(first)||first<1||first>500))throw new Error('前N条须为1至500之间的整数');
  let before=time;
  if(before!==null){
    if(typeof before!=='string'||!/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(before))throw new Error('截止时间格式应为HH:mm或HH:mm:ss');
    if(before.length===5)before+=':00';
  }
  return {first_n:first,before_time:before};
}
export function describeAnalysisRule(value={}) {
  const r=normalizeAnalysisRule(value),parts=[];
  if(r.before_time!==null)parts.push(`买入时间严格早于 ${r.before_time}`);
  if(r.first_n!==null)parts.push(`每个买入日期最早 ${r.first_n} 条样本`);
  return parts.length?parts.join('，再取'):'全部策略样本';
}
export function selectAnalysisSamples(records,value={}) {
  const r=normalizeAnalysisRule(value),counts=new Map(),decisions=new Map(),selected=[];
  const ordered=[...records].sort((a,b)=>{
    for(const key of ['buy_time','created_at','id']){const x=String(a[key]??''),y=String(b[key]??'');if(x!==y)return x<y?-1:1;}return 0;
  });
  for(const row of ordered){
    const time=row.buy_time.slice(11).padEnd(8,':00');
    if(r.before_time!==null&&time>=r.before_time){decisions.set(row.id,'达到或晚于截止时间');continue;}
    const group=row.strategy_id+'|'+row.buy_time.slice(0,10),rank=(counts.get(group)??0)+1;counts.set(group,rank);
    if(r.first_n!==null&&rank>r.first_n){decisions.set(row.id,`超过当日最早${r.first_n}条`);continue;}
    selected.push(row);decisions.set(row.id,'入选');
  }
  return {selected,decisions};
}
