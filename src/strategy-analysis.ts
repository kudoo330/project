import schema from '../migrations/0002_strategy_analysis.sql';
import {normalizeAnalysisRule} from '../public/analysis-scope.js';
import type {Env} from './types';
import type {AnalysisRule} from '../public/analysis-scope.js';
const ready=new WeakMap<object,Promise<void>>();
export function ensureAnalysisSchema(env:Env) {
  let pending=ready.get(env.DB);
  if(!pending){
    // This versioned migration only creates a missing new table; it never alters existing data.
    // Also supports users whose dashboard build still uses `wrangler deploy` directly.
    pending=env.DB.prepare(schema).run().then(()=>{}).catch(e=>{ready.delete(env.DB);throw e;});
    ready.set(env.DB,pending);
  }
  return pending;
}
export interface StrategyRow {id:string;name:string;archived:number;analysis_rule:AnalysisRule;analysis_revision:number;analysis_updated_at:string|null}
export async function listStrategies(env:Env):Promise<StrategyRow[]> {
  await ensureAnalysisSchema(env);
  const rows=(await env.DB.prepare(`SELECT s.*,a.rule_json,a.revision AS analysis_revision,a.updated_at AS analysis_updated_at
    FROM strategies s LEFT JOIN strategy_analysis_rules a ON a.strategy_id=s.id ORDER BY s.created_at,s.id`).all<any>()).results;
  return rows.map(({rule_json,...r})=>({...r,analysis_rule:normalizeAnalysisRule(rule_json?JSON.parse(rule_json):{}),analysis_revision:r.analysis_revision??0,analysis_updated_at:r.analysis_updated_at??null}));
}
