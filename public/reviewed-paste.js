// Tab-separated reviewed records. Dates and prices are explicit; no implicit fill prices.
export const reviewedPasteHeader='策略\t股票代码\t股票名称\t买入时间\t参考价\t价格来源\t原始时间\t东方财富价\t新浪价';
export function parseReviewedPaste(text){
  const lines=text.replace(/^\uFEFF/,'').replace(/^[\r\n]+|[\r\n]+$/g,'').split(/\r?\n/);
  if(lines[0]!==reviewedPasteHeader)return null;
  if(lines.length<2||lines.length>251)throw new Error('核验文字支持1至250条');
  return lines.slice(1).map((line,index)=>{
    const v=line.split('\t');if(v.length!==9)throw new Error('第'+(index+2)+'行列数不正确，请完整复制');
    const [strategy,symbol,name,buy_time,price,provider,original_time,em,sina]=v;
    if(!strategy||!/^\d{6}\.(SH|SZ|BJ)$/.test(symbol)||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(buy_time))throw new Error('第'+(index+2)+'行策略、代码或时间错误');
    if(price!==''&&(!Number.isFinite(Number(price))||Number(price)<=0))throw new Error('第'+(index+2)+'行参考价无效');
    if(!['东方财富','新浪','用户手动提供'].includes(provider))throw new Error('第'+(index+2)+'行来源无效');
    const evidence={provider,field:'open',interval:'1m',source_label:buy_time.replace('T',' ').slice(0,16)+':00',interval_boundary_verified:false,primary_open:em&&em!=='-'?em:null,secondary_open:sina&&sina!=='-'?sina:null,selection_rule:'东方财富优先，缺少时新浪补充；手工指定优先保留',import_method:'用户粘贴已核验清单',note:'分钟参考价不代表实际成交价'};
    if(provider==='用户手动提供')evidence.manual_override={value:price,provided_by:'用户'};
    return {strategy,symbol,name,buy_time,original_time:original_time&&original_time!=='-'?original_time:buy_time,reference_price:price||null,reference_evidence:evidence};
  });
}
