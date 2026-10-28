/** Future-only contracts. No strategy execution, broker or live subscription is
 * implemented or enabled by declaring these interfaces. */
export type ResearchTimeframe = '1m' | '5m' | '15m' | '30m' | '60m' | '1d';
export interface StrategyManifest {
  strategyId: string;
  version: string;
  displayName: string;
  symbols: string[];
  timeframes: ResearchTimeframe[];
  parameterSchema: Record<string, unknown>;
  description?: string;
}
export interface ResearchSignal {
  readonly id: string;
  readonly strategyId: string;
  readonly strategyVersion: string;
  readonly symbol: string;
  readonly action: 'BUY' | 'SELL' | 'REBUY';
  readonly signalTimeUtc: string;
  readonly decisionDataCutoffUtc: string;
  rationale?: string;
  readonly inputDataRevision: string;
  status: 'candidate' | 'confirmed' | 'invalidated';
}
export interface StrategyPlugin { readonly manifest: StrategyManifest }
export interface MarketDataSnapshot<TBar = unknown> {
  readonly datasetId: string;
  readonly revision: number;
  readonly provider: string;
  readonly adjustment: string;
  readonly bars: readonly TBar[];
  readonly quality: Readonly<Record<string, unknown>>;
}
export interface MarketDataAdapter<TBar = unknown> {
  readonly providerId: string;
  history(query: Readonly<{symbol: string; startUtc: string; endUtc: string; timeframe: '1m' | '1d'}>): Promise<MarketDataSnapshot<TBar>>;
  /** Declaration only; this platform does not start a stream. */
  subscribe?: (query: Readonly<{symbol: string}>, onFinalBar: (snapshot: MarketDataSnapshot<TBar>) => void) => Promise<() => void>;
}
export interface SignalStore {
  /** Future implementation must reject modification of signalTimeUtc/cutoff. */
  append(signal: Readonly<ResearchSignal>): Promise<void>;
  versions(id: string): Promise<readonly Readonly<ResearchSignal>[]>;
}
