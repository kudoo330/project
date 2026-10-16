export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ADMIN_USERNAME: string;
  ADMIN_PASSWORD_HASH?: string;
  VIEWER_USERNAME?: string;
  VIEWER_PASSWORD_HASH?: string;
}
export interface Identity { username: string; role: 'admin' | 'viewer' }
export interface Bar { date: string; open: number; high: number; low: number; close: number; volume: number }
export interface RecordRow {
  id: string; batch_id: string; strategy_id: string; strategy_name?: string; version: string;
  symbol: string; name: string; original_time: string; buy_time: string;
  actual_price: number | null; shares: number | null; reason: string; tags: string; notes: string;
  checked_through: string | null;
  reference_price: number | null; pricing_status: string; reference_evidence: string | null;
  market_data: string | null; fetched_at: string | null; error: string | null;
  revision: number; created_at: string; updated_at: string;
}
