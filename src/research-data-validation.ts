export const RESEARCH_MAX_ROWS = 500;
export const RESEARCH_STATUSES = ['available', 'missing', 'not_entitled', 'request_failed', 'no_eligible_trade'] as const;
export type ResearchStatus = typeof RESEARCH_STATUSES[number];
export interface ResearchDatasetInput {
  symbol: 'AMD.US' | 'AMDL.US'; period: '1m' | '1d'; provider: string;
  adjustment: 'none' | 'forward'; adjustment_as_of: string | null;
  time_zone: 'America/New_York'; currency: 'USD';
}
export interface ResearchRow {
  time: string; original_time: string; trading_date: string; session: string;
  open: number | null; high: number | null; low: number | null; close: number | null;
  volume: number | null; status: ResearchStatus; reason: string;
  original_values: Record<string, string | number | null>;
}
export interface ResearchInput { dataset: ResearchDatasetInput; source_note: string; rows: ResearchRow[] }
export interface ResearchError { row: number; field: string; message: string }
export type ResearchAction = 'insert' | 'fill' | 'unchanged' | 'conflict' | 'blocked';
export interface StoredResearchRow extends ResearchRow { source_note: string; revision: number }
export interface PlannedResearchRow extends ResearchRow { action: ResearchAction }

const ny = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
export function nyParts(value: Date) {
  const parts = Object.fromEntries(ny.formatToParts(value).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second) };
}
export function validDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    value >= '1900-01-01' && Number.isFinite(Date.parse(value + 'T00:00:00Z')) &&
    new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
}
function requiredText(value: unknown, label: string, max: number) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    throw new Error(`${label}不能为空、含控制字符或超过${max}字`);
  }
  return value.trim();
}
export function normalizeResearchTime(value: unknown, period: '1m' | '1d') {
  if (period === '1d') {
    if (!validDate(value)) throw new Error('日线时间需为有效的 YYYY-MM-DD 纽约交易日期');
    return { time: value, original_time: value, trading_date: value, session: 'regular' };
  }
  if (typeof value !== 'string') throw new Error('分钟时间必须带 Z 或明确 UTC 偏移');
  const match = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/);
  if (!match || !validDate(match[1]) || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4] ?? 0) !== 0 || Number(match[5] ?? 0) !== 0) {
    throw new Error('分钟时间需为有效的整分钟 ISO 时间，且带 Z 或偏移，例如 2026-10-27T09:30:00-04:00');
  }
  const offset = match[6];
  if (offset !== 'Z' && (Number(offset.slice(1, 3)) > 14 || Number(offset.slice(4)) > 59 || Number(offset.slice(1, 3)) === 14 && Number(offset.slice(4)) !== 0)) {
    throw new Error('UTC偏移无效');
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || milliseconds % 60000 !== 0) throw new Error('分钟时间无效');
  const date = new Date(milliseconds), local = nyParts(date);
  // NY-looking wall times must use the actual DST offset; other explicit offsets
  // (for example +08:00) and Z represent absolute instants and are converted.
  if (['-04:00', '-05:00'].includes(offset) && (local.date !== match[1] || local.hour !== Number(match[2]) || local.minute !== Number(match[3]))) {
    throw new Error('纽约时间与夏令时偏移不一致，请使用正确的 -04:00/-05:00 或 UTC 时间');
  }
  const minute = local.hour * 60 + local.minute;
  const session = minute < 240 || minute >= 1200 ? 'overnight' : minute < 570 ? 'pre' : minute < 960 ? 'regular' : 'post';
  return { time: date.toISOString(), original_time: value, trading_date: local.date, session };
}
const empty = (value: unknown) => value === null || value === undefined || typeof value === 'string' && value.trim() === '';
function numeric(value: unknown, label: string, nullable = false): number | null {
  if (empty(value)) { if (nullable) return null; throw new Error(`${label}缺失`); }
  if (typeof value !== 'number' && typeof value !== 'string' || typeof value === 'string' && !/^[+]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim())) throw new Error(`${label}必须为有效数字`);
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1e15) throw new Error(`${label}超出有效范围`);
  return number;
}
export function validateResearchInput(value: unknown, clock = new Date()): { input?: ResearchInput; errors: ResearchError[] } {
  const errors: ResearchError[] = [], data = value as any;
  let dataset: ResearchDatasetInput | undefined, source_note = '';
  try {
    if (!data || typeof data !== 'object' || !data.dataset || typeof data.dataset !== 'object') throw new Error('缺少数据集信息');
    const d = data.dataset;
    if (!['AMD.US', 'AMDL.US'].includes(d.symbol)) throw new Error('本入口支持 AMD.US、AMDL.US');
    if (!['1m', '1d'].includes(d.period)) throw new Error('周期只能为1m或1d，日线必须独立提供');
    if (!['none', 'forward'].includes(d.adjustment)) throw new Error('复权方式只能为none或forward');
    if (d.time_zone !== 'America/New_York' || d.currency !== 'USD') throw new Error('研究数据集使用America/New_York和USD');
    if (d.adjustment === 'forward' && (!validDate(d.adjustment_as_of) || d.adjustment_as_of > nyParts(clock).date)) throw new Error('前复权必须提供有效且不晚于今天的复权截至日期');
    if (d.adjustment === 'none' && !empty(d.adjustment_as_of)) throw new Error('不复权数据不能填写复权截至日期');
    dataset = { symbol: d.symbol, period: d.period, provider: requiredText(d.provider, '数据来源', 80), adjustment: d.adjustment,
      adjustment_as_of: d.adjustment === 'forward' ? d.adjustment_as_of : null, time_zone: d.time_zone, currency: d.currency };
    source_note = requiredText(data.source_note, '来源依据', 2000);
  } catch (error) { errors.push({ row: 0, field: 'dataset', message: (error as Error).message }); }
  if (!Array.isArray(data?.rows) || data.rows.length < 1 || data.rows.length > RESEARCH_MAX_ROWS) {
    errors.push({ row: 0, field: 'rows', message: `每批需要1至${RESEARCH_MAX_ROWS}行` });
    return { errors };
  }
  const rows: ResearchRow[] = [], seen = new Set<string>(), current = nyParts(clock);
  if (dataset) data.rows.forEach((raw: any, index: number) => {
    try {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('行数据必须为对象');
      const time = normalizeResearchTime(raw.time, dataset!.period);
      if (dataset!.adjustment === 'forward' && time.trading_date > dataset!.adjustment_as_of!) throw new Error('行情日期不能晚于前复权截至日期；请使用正确的复权数据集');
      if (seen.has(time.time)) throw new Error('同一批存在重复时间；请先合并或纠正');
      seen.add(time.time);
      const status = raw.status ?? 'available';
      if (!RESEARCH_STATUSES.includes(status)) throw new Error('状态无效，不能将缺价标为停牌');
      const reason = empty(raw.reason) ? '' : requiredText(raw.reason, '原因', 1000);
      let prices: Array<number | null>;
      if (status === 'available') {
        prices = ['open', 'high', 'low', 'close'].map(key => numeric(raw[key], key));
        const [open, high, low, close] = prices as number[];
        if (low <= 0 || low > Math.min(open, close) || high < Math.max(open, close) || high < low) throw new Error('OHLC须为正数且满足最低≤开盘/收盘≤最高');
        if (dataset!.period === '1m' && Date.parse(time.time) + 60000 > clock.getTime()) throw new Error('不能将未来或尚未结束的分钟导入为完整行情');
        if (dataset!.period === '1d' && (time.trading_date > current.date || time.trading_date === current.date && current.hour < 16)) throw new Error('不能将未来或纽约当日16:00前的日线导入为完整行情');
      } else {
        if (!['open', 'high', 'low', 'close'].every(key => empty(raw[key]))) throw new Error('缺失状态的OHLC必须全部留空，不能用0或部分价格代替');
        if (!reason) throw new Error('缺失、权限受限、请求失败或无合格成交必须填写原因');
        prices = [null, null, null, null];
      }
      const volume = numeric(raw.volume, '成交量', true);
      if (volume !== null && !Number.isSafeInteger(volume)) throw new Error('成交量需为非负安全整数或留空');
      const original_values = Object.fromEntries(['open', 'high', 'low', 'close', 'volume'].map(k => [k, empty(raw[k]) ? null : raw[k]]));
      rows.push({ ...time, open: prices[0], high: prices[1], low: prices[2], close: prices[3], volume, status, reason, original_values });
    } catch (error) { errors.push({ row: index + 1, field: 'row', message: (error as Error).message }); }
  });
  if (errors.length || !dataset) return { errors };
  rows.sort((a, b) => a.time.localeCompare(b.time));
  return { input: { dataset, source_note, rows }, errors };
}
export async function researchDigest(value: unknown) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('');
}
export async function researchDatasetId(dataset: ResearchDatasetInput) {
  return 'market_' + await researchDigest(dataset);
}
export function planResearchRows(input: ResearchInput, existing: StoredResearchRow[]) {
  const saved = new Map(existing.map(row => [row.time, row]));
  const counts = { insert: 0, fill: 0, unchanged: 0, conflict: 0, missing: 0, blocked: 0 };
  const rows: PlannedResearchRow[] = input.rows.map(row => {
    const old = saved.get(row.time);
    let action: ResearchAction;
    if (!old) action = 'insert';
    else if (old.status === 'available' && row.status !== 'available') action = 'blocked';
    else if (['open', 'high', 'low', 'close', 'volume', 'status', 'reason'].every(k => (old as any)[k] === (row as any)[k]) && old.source_note === input.source_note) action = 'unchanged';
    else if (old.status !== 'available' && row.status === 'available') action = 'fill';
    else action = 'conflict';
    counts[action]++;
    if (row.status !== 'available') counts.missing++;
    return { ...row, action };
  });
  return { counts, rows };
}
export async function researchPreviewToken(input: ResearchInput, revision: number, existing: StoredResearchRow[]) {
  return researchDigest({ input, revision, existing: [...existing].sort((a, b) => a.time.localeCompare(b.time)) });
}
