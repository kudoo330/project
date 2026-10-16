import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeAnalysisRule,selectAnalysisSamples} from '../public/analysis-scope.js';
import {analysisSummary} from '../src/analysis-summary';
import type {RecordRow} from '../src/types';
import type {StrategyRow} from '../src/strategy-analysis';
const sample=(id:string,time:string,strategy='a',date='2026-10-15')=>({id,strategy_id:strategy,buy_time:date+'T'+time,created_at:'2026-10-15T08:00:00Z'});
test('first N resets independently for each strategy and Shanghai buy date',()=>{
  const rows=[sample('a3','10:00:00'),sample('a1','09:31:00'),sample('a2','09:45:00'),sample('b1','09:31:00','b'),sample('b2','09:32:00','b'),sample('next1','09:31:00','a','2026-10-16'),sample('next2','09:32:00','a','2026-10-16')];
  const original=rows.map(r=>r.id),selected=selectAnalysisSamples(rows,{first_n:1}).selected;
  assert.deepEqual(selected.map(r=>r.id),['a1','b1','next1']);assert.deepEqual(rows.map(r=>r.id),original);assert.equal(selectAnalysisSamples(rows,{}).selected.length,7);
});
test('cutoff is strict to the second and combines before first N',()=>{
  const rows=[sample('after','13:00:01'),sample('boundary','13:00:00'),sample('just-before','12:59:59'),sample('early','09:40:00'),sample('late-morning','11:29:59')];
  const rule=normalizeAnalysisRule({before_time:'13:00',first_n:2});assert.equal(rule.before_time,'13:00:00');
  const result=selectAnalysisSamples(rows,rule);assert.deepEqual(result.selected.map(r=>r.id),['early','late-morning']);assert.equal(result.decisions.get('boundary'),'达到或晚于截止时间');assert.equal(result.decisions.get('just-before'),'超过当日最早2条');
  assert.deepEqual(selectAnalysisSamples(rows,{before_time:'13:00'}).selected.map(r=>r.id),['early','late-morning','just-before']);
});
test('ties deterministic and repeated stocks count separately; price does not change membership',()=>{
  const rows=[{...sample('z','09:40:00'),symbol:'300111.SZ',actual_price:3},{...sample('a','09:40:00'),symbol:'300111.SZ',actual_price:null},{...sample('old','09:40:00'),symbol:'300111.SZ',created_at:'2026-10-15T07:00:00Z',actual_price:null}];
  assert.deepEqual(selectAnalysisSamples(rows,{first_n:2}).selected.map(r=>r.id),['old','a']);assert.equal(selectAnalysisSamples(rows,{}).selected.length,3);
});
test('invalid analysis parameters fail explicitly',()=>{
  for(const r of [{first_n:0},{first_n:1.5},{first_n:'10'},{first_n:501},{before_time:'25:00'},{before_time:'13:60'},null,[]])assert.throws(()=>normalizeAnalysisRule(r));
});
test('server summary preserves original aggregate and calculates selected sample weights and denominators',()=>{
  const record=(id:string,strategy:string,time:string,close:number,base:number|null=10)=>({...sample(id,time,strategy),symbol:'300111.SZ',actual_price:base,reference_price:null,checked_through:'2026-10-15',market_data:JSON.stringify({bars:[{date:'2026-10-15',close}]})}) as RecordRow;
  const rows=[record('a1','a','09:31:00',11),record('a2','a','10:00:00',10),record('b1','b','14:00:00',11),record('b2','b','10:00:00',9)];
  const strategy=(id:string,rule:unknown)=>({id,name:id,analysis_rule:normalizeAnalysisRule(rule)}) as StrategyRow;
  const groups=analysisSummary(rows,[strategy('a',{first_n:1}),strategy('b',{before_time:'13:00'})],new Date('2026-10-16T03:00:00Z'));
  assert.equal(groups[0].samples,4);assert.ok(Math.abs(groups[0].points[0].mean!-2.5)<1e-10);assert.equal(groups[0].points[0].positive,.5);
  assert.equal(groups[1].samples,2);assert.equal(groups[1].unique_stocks,1);assert.ok(Math.abs(groups[1].points[0].mean!)<1e-10);assert.equal(groups[1].points[0].count,2);
  assert.deepEqual(groups[2].selected_ids,['a1']);assert.equal(groups[2].excluded_samples,1);assert.deepEqual(groups[3].selected_ids,['b2']);assert.equal(groups[2].points[1].mean,null);
  const noPrice=analysisSummary([{...rows[0],actual_price:null},rows[1]],[strategy('a',{first_n:1})],new Date('2026-10-16T03:00:00Z'))[2];assert.deepEqual(noPrice.selected_ids,['a1']);assert.equal(noPrice.points[0].count,0);
});
