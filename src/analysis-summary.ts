import {normalizeAnalysisRule,selectAnalysisSamples,describeAnalysisRule} from '../public/analysis-scope.js';
import {summarize} from './domain';
import {track} from './tracking';
import type {RecordRow} from './types';
import type {StrategyRow} from './strategy-analysis';
export function analysisSummary(records:RecordRow[],strategies:StrategyRow[],now=new Date()) {
  const tracked=new Map(records.map(r=>[r.id,track(r,now)]));
  const group=(id:string,name:string,all:RecordRow[],selected:RecordRow[],rule:unknown)=>({
    strategy_id:id,name,total_samples:all.length,samples:selected.length,excluded_samples:all.length-selected.length,
    unique_stocks:new Set(selected.map(r=>r.symbol)).size,analysis_rule:normalizeAnalysisRule(rule),rule_description:describeAnalysisRule(rule),
    points:Array.from({length:11},(_,n)=>summarize(selected.map(r=>tracked.get(r.id)!.window[n].value))),
    selected_ids:selected.map(r=>r.id)
  });
  const groups=strategies.map(s=>{const rows=records.filter(r=>r.strategy_id===s.id),selection=selectAnalysisSamples(rows,s.analysis_rule);return group(s.id,s.name,rows,selection.selected,s.analysis_rule);});
  const included=new Set(groups.flatMap(g=>g.selected_ids)),selected=records.filter(r=>included.has(r.id));
  return [group('all','全部策略 · 原始样本',records,records,{}),group('analysis-all','全部策略 · 各自范围入选',records,selected,{}),...groups];
}
