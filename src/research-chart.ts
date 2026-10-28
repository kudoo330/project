import type { Env } from './types';
import type { ResearchDatasetInput, ResearchStatus } from './research-data-validation';
import { validDate } from './research-data-validation';
import { addUSDate, US_CALENDAR, usCalendarDay, usMinuteUTC, type USSession } from './us-market-calendar';
import type { ResearchTimeframe } from './research-contracts';

export type ChartDataset = ResearchDatasetInput & { id: string; revision: number; updated_at?: string };
export interface ChartSourceRow {
  time_key: string; trading_date: string; open: number | null; high: number | null;
  low: number | null; close: number | null; volume: number | null;
  status: ResearchStatus; reason: string; source_note: string; revision: number;
  updated_at?: string; verification?: string;
}
export interface ResearchChartBar {
  time: string; time_utc: string; end_utc: string;
  interval_start_utc: string; interval_end_utc: string;
  trading_date: string; session: USSession; timeframe: ResearchTimeframe;
  open: number | null; high: number | null; low: number | null; close: number | null; volume: number | null;
  status: ResearchStatus | 'partial'; reason: string;
  expected_minutes: number; available_minutes: number; missing_minutes: number;
  no_eligible_minutes: number; unknown_volume_minutes: number;
  source_revision: number; row_revisions: number[]; is_final: boolean; complete: boolean;
  bar_revision?: number;
  short_window: boolean; source_note: string;
}
const TIMEFRAMES = ['1m','5m','15m','30m','60m','1d'] as const;
const SESSION_NAMES = ['pre','regular','post'] as const;
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control':'private, no-store' } });
const iso = (milliseconds: number) => new Date(milliseconds).toISOString();
const minDate = (a: string, b: string) => a < b ? a : b;

function newBar(dataset: ChartDataset, day: string, session: USSession, timeframe: ResearchTimeframe, start: number, end: number, expected: number): ResearchChartBar {
  return { time: timeframe === '1d' ? day : iso(start), time_utc: iso(start), end_utc: iso(end),
    interval_start_utc:iso(start), interval_end_utc:iso(end), trading_date:day,session,timeframe,
    open:null,high:null,low:null,close:null,volume:null,status:'missing',reason:'尚未载入此窗口行情',
    expected_minutes:expected,available_minutes:0,missing_minutes:expected,no_eligible_minutes:0,unknown_volume_minutes:0,
    source_revision:dataset.revision,row_revisions:[],is_final:true,complete:false,
    short_window:timeframe!=='1d' && expected < Number.parseInt(timeframe),source_note:'' };
}

function combineRows(bar: ResearchChartBar, rows: ChartSourceRow[], absent: number) {
  const unit = bar.timeframe === '1d' ? '交易日' : '分钟';
  const available = rows.filter(row => row.status === 'available');
  const noEligible = rows.filter(row => row.status === 'no_eligible_trade');
  bar.available_minutes = available.length;
  bar.no_eligible_minutes = noEligible.length;
  bar.missing_minutes = bar.expected_minutes - available.length - noEligible.length;
  // Price availability and volume availability are independent. A supplier can
  // return a known traded volume with unavailable OHLC; preserve that evidence.
  bar.unknown_volume_minutes = absent + rows.filter(row => row.volume === null).length;
  bar.row_revisions = [...new Set(rows.map(row=>row.revision))].sort((a,b)=>a-b);
  if ((bar.timeframe === '1m' || bar.timeframe === '1d') && rows.length === 1) bar.bar_revision = rows[0].revision;
  bar.source_note = [...new Set(rows.map(row=>row.source_note).filter(Boolean))].join('\n');
  const reasons = [...new Set(rows.filter(row=>row.status!=='available').map(row=>row.reason).filter(Boolean))];
  if (absent) reasons.unshift(`${absent}个${unit}尚未载入`);
  if (bar.unknown_volume_minutes) reasons.push(`${bar.unknown_volume_minutes}个${unit}成交量缺失`);
  const summedVolume = rows.reduce((sum,row)=>sum+(row.volume??0),0);
  bar.volume = bar.unknown_volume_minutes || !Number.isSafeInteger(summedVolume) ? null : summedVolume;
  if(!Number.isSafeInteger(summedVolume)) {bar.unknown_volume_minutes=bar.expected_minutes;reasons.push('聚合成交量超过安全整数范围，保留为空');}
  if (available.length) {
    bar.open = available[0].open;
    bar.high = Math.max(...available.map(row=>row.high!));
    bar.low = Math.min(...available.map(row=>row.low!));
    bar.close = available[available.length-1].close;
    // Legitimate no-eligible-trade minutes do not fabricate prices or volume.
    // They are explained separately and are not unknown missing observations.
    bar.complete = bar.missing_minutes === 0 && bar.unknown_volume_minutes === 0;
    bar.status = bar.complete ? 'available' : 'partial';
  } else if (!bar.missing_minutes && noEligible.length === bar.expected_minutes) {
    bar.status = 'no_eligible_trade'; bar.complete = true;
  } else if (!absent && rows.length && rows.every(row=>row.status===rows[0].status)) {
    bar.status = rows[0].status;
  }
  bar.reason = reasons.join('；') || (bar.status === 'available' ? '' : '尚未载入此窗口行情');
  return bar;
}

/** Pure aggregation over a bounded viewport. The dataset revision is attached to
 * every result and rows are re-read on every request, so a source correction
 * cannot leave a derived cache stale. No OHLC or volume is forward-filled. */
export function buildResearchChart(dataset: ChartDataset, rows: ChartSourceRow[], options: {
  start: string; end: string; timeframe: ResearchTimeframe; sessions: USSession[]; now?: number;
}) {
  const { start, end, timeframe, sessions } = options, now = options.now ?? Date.now();
  if (!validDate(start) || !validDate(end) || start > end) throw new Error('需要有效且顺序正确的日期范围');
  usCalendarDay(start); usCalendarDay(end);
  if ((timeframe==='1d') !== (dataset.period==='1d')) throw new Error('日线必须选择独立日线数据集；分钟周期必须选择1分钟数据集');
  const map = new Map(rows.map(row => [row.time_key,row])), used = new Set<string>();
  const bars: ResearchChartBar[] = [], warnings: string[] = [];
  let tradingDays=0, futureWindows=0, halfDays=0;
  for(let day=start; day<=end; day=addUSDate(day,1)) {
    const calendar = usCalendarDay(day);
    if (!calendar.is_trading_day) continue;
    tradingDays++;
    if(calendar.early_close && sessions.includes('post')) halfDays++;
    if(timeframe==='1d') {
      const startMs=usMinuteUTC(day,570), endMs=usMinuteUTC(day,calendar.regular_close_minute);
      if(endMs>now) {futureWindows++; continue;}
      const bar=newBar(dataset,day,'regular',timeframe,startMs,endMs,1), row=map.get(day);
      if(row)used.add(day);
      combineRows(bar,row?[row]:[],row?0:1);
      // This count is one independent daily observation, not synthetic minutes.
      if(!row)bar.reason='尚未载入此交易日的独立日线';
      bars.push(bar);continue;
    }
    const width=Number.parseInt(timeframe);
    for(const session of calendar.sessions.filter(window=>sessions.includes(window.session))) {
      // US DST transitions happen outside these daytime sessions. Resolve the
      // IANA offset once per session, not thousands of times per viewport.
      const anchorMs=usMinuteUTC(day,session.start_minute);
      for(let minute=session.start_minute;minute<session.end_minute;minute+=width) {
        const finish=Math.min(minute+width,session.end_minute), expected=finish-minute;
        const startMs=anchorMs+(minute-session.start_minute)*60000,endMs=anchorMs+(finish-session.start_minute)*60000;
        if(endMs>now) {futureWindows++;continue;}
        const windowRows: ChartSourceRow[]=[];
        for(let at=startMs;at<endMs;at+=60000) {
          const key=iso(at),row=map.get(key);
          if(row){windowRows.push(row);used.add(key);}
        }
        bars.push(combineRows(newBar(dataset,day,session.session,timeframe,startMs,endMs,expected),windowRows,expected-windowRows.length));
      }
    }
  }
  if(halfDays)warnings.push(`${halfDays}个半日市的盘后时段尚未核实，未生成盘后K线。`);
  if(futureWindows)warnings.push('未来或尚未结束的K线窗口未计入价格与完整度。');
  const excludedRows=rows.filter(row=>!used.has(row.time_key)).length;
  if(excludedRows)warnings.push(`${excludedRows}条原始记录位于所选时段外、休市日或尚未结束的窗口，未参与聚合。`);
  warnings.push('行情保留导入来源，尚未完成独立数据源交叉验证。');
  const expected=bars.reduce((sum,bar)=>sum+bar.expected_minutes,0), available=bars.reduce((sum,bar)=>sum+bar.available_minutes,0);
  const noEligible=bars.reduce((sum,bar)=>sum+bar.no_eligible_minutes,0);
  return {bars,warnings,coverage:{
    unit:timeframe==='1d'?'trading_day':'minute',expected_minutes:expected,available_minutes:available,
    missing_minutes:expected-available-noEligible,no_eligible_minutes:noEligible,
    percent:expected?Math.round((available+noEligible)/expected*10000)/100:null,
    price_percent:expected?Math.round(available/expected*10000)/100:null,
    unknown_volume_minutes:bars.reduce((sum,bar)=>sum+bar.unknown_volume_minutes,0),
    trading_days:tradingDays,incomplete_bars:bars.filter(bar=>!bar.complete).length,
    source_revision:dataset.revision,excluded_rows:excludedRows,unclosed_windows:futureWindows,
    calendar_status:US_CALENDAR.status,calendar:US_CALENDAR,
    status:!expected?'unassessed':bars.every(bar=>bar.complete)?'complete':'partial',
  }};
}

export async function researchChartApi(request: Request, env: Env, url: URL): Promise<Response> {
  if(request.method!=='GET')return json({error:'图表接口只允许读取'},405);
  try {
    const id=url.searchParams.get('dataset_id')??'', timeframe=url.searchParams.get('timeframe')??'1m';
    if(!/^market_[a-f0-9]{64}$/.test(id))return json({error:'请选择有效的行情数据集'},400);
    if(!TIMEFRAMES.includes(timeframe as ResearchTimeframe))return json({error:'不支持此K线周期'},400);
    const start=url.searchParams.get('start'),end=url.searchParams.get('end');
    if(!validDate(start)||!validDate(end)||start>end)return json({error:'请选择有效的开始与结束日期'},400);
    if(start<US_CALENDAR.from||end>US_CALENDAR.through)return json({error:'美股日历目前仅覆盖2025–2026年；该年份日历尚未核实',code:'calendar_not_covered',calendar:US_CALENDAR},422);
    const supplied=url.searchParams.get('sessions'),sessions=(supplied===null?[...SESSION_NAMES]:supplied.split(',')) as USSession[];
    if(!sessions.length||sessions.some(session=>!SESSION_NAMES.includes(session))||new Set(sessions).size!==sessions.length)return json({error:'请选择盘前、常规或盘后时段'},400);
    const cursor=url.searchParams.get('cursor');
    if(cursor&&(!validDate(cursor)||cursor<start||cursor>end))return json({error:'分页日期不在所选范围内'},400);
    const pageDays=timeframe==='1d'?366:timeframe==='1m'?1:3;
    const pageStart=cursor??start,pageEnd=minDate(end,addUSDate(pageStart,pageDays-1));
    const dataset=await env.DB.prepare('SELECT * FROM research_market_datasets WHERE id=?').bind(id).first<ChartDataset>();
    if(!dataset)return json({error:'行情数据集不存在'},404);
    if((timeframe==='1d')!==(dataset.period==='1d'))return json({error:'日线需选择独立日线数据集；其他周期需选择1分钟数据集',code:'dataset_period_mismatch'},400);
    // A viewport has at most 3*1440 raw minute rows. Read them without LIMIT so
    // malformed/imported off-session rows never silently displace valid bars.
    const result=await env.DB.prepare('SELECT time_key,trading_date,open,high,low,close,volume,status,reason,source_note,revision,updated_at,verification FROM research_market_bars WHERE dataset_id=? AND trading_date>=? AND trading_date<=? ORDER BY time_key').bind(id,pageStart,pageEnd).all<ChartSourceRow>();
    // Metadata and rows are separate reads. Detect concurrent imports instead of
    // labeling a mixed snapshot with an old revision.
    const final=await env.DB.prepare('SELECT revision FROM research_market_datasets WHERE id=?').bind(id).first<{revision:number}>();
    if(final?.revision!==dataset.revision)return json({error:'行情刚被修订，请重新加载此窗口',code:'dataset_changed'},409);
    const chart=buildResearchChart(dataset,result.results,{start:pageStart,end:pageEnd,timeframe:timeframe as ResearchTimeframe,sessions});
    return json({dataset,timeframe,time_zone:'America/New_York',sessions,
      range:{start,end,page_start:pageStart,page_end:pageEnd},...chart,
      next_cursor:pageEnd<end?addUSDate(pageEnd,1):null,
      limits:{minute_page_calendar_days:timeframe==='1m'?1:3,daily_page_calendar_days:366},
      data_access:{mode:'persisted_only',automatic_download:false,manual_import_url:'/market-data',reason:'历史行情缺口可通过手动导入补充'},
    });
  } catch(error) { return json({error:(error as Error).message},400); }
}
