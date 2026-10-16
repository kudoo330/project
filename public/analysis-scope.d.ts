export interface AnalysisRule { first_n:number|null; before_time:string|null }
export interface AnalysisSample { id:string; strategy_id:string; buy_time:string; created_at:string }
export function normalizeAnalysisRule(value?:unknown):AnalysisRule;
export function describeAnalysisRule(value?:unknown):string;
export function selectAnalysisSamples<T extends AnalysisSample>(records:T[],value?:unknown):{selected:T[];decisions:Map<string,string>};
