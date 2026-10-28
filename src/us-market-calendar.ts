import { nyParts, validDate } from './research-data-validation';

export type USSession = 'pre' | 'regular' | 'post';
export interface USSessionWindow { session: USSession; start_minute: number; end_minute: number }

/** NYSE cash-equity reference schedule. Keep the explicit coverage boundary:
 * missing future calendar years must never silently become weekday calendars.
 * Source: https://www.nyse.com/markets/hours-calendars
 * This release has a locally reviewed 2026 schedule, not a live calendar feed.
 * Extended-hours venues have their own early-close schedules. Until separately
 * verified, we deliberately do not generate post-market bars on half-days.
 */
export const US_CALENDAR = {
  id: 'us-cash-equity-2026-v1', from: '2026-01-01', through: '2026-12-31',
  source: 'https://www.nyse.com/markets/hours-calendars',
  status: 'reference_schedule',
  note: '2026年美股现货参考日历；半日市盘后时段尚未核实，不生成盘后窗口。',
} as const;
const HOLIDAYS = new Set(['2026-01-01','2026-01-19','2026-02-16','2026-04-03','2026-05-25','2026-06-19','2026-07-03','2026-09-07','2026-11-26','2026-12-25']);
const EARLY_CLOSE = new Set(['2026-11-27','2026-12-24']);

export function addUSDate(date: string, days: number) {
  return new Date(Date.parse(date + 'T00:00:00Z') + days * 86400000).toISOString().slice(0,10);
}
export function usCalendarDay(date: string) {
  if (!validDate(date) || date < US_CALENDAR.from || date > US_CALENDAR.through) throw new Error('美股日历目前仅覆盖2026年；请先核实该年份日历');
  const weekday = new Date(date + 'T12:00:00Z').getUTCDay();
  const is_trading_day = weekday !== 0 && weekday !== 6 && !HOLIDAYS.has(date);
  const early_close = EARLY_CLOSE.has(date), regular_close_minute = early_close ? 780 : 960;
  const sessions: USSessionWindow[] = is_trading_day ? [
    { session: 'pre', start_minute: 420, end_minute: 570 },
    { session: 'regular', start_minute: 570, end_minute: regular_close_minute },
    ...(!early_close ? [{ session: 'post' as const, start_minute: 960, end_minute: 1200 }] : []),
  ] : [];
  return { date, is_trading_day, early_close, regular_close_minute, sessions };
}

/** Convert a NY wall-clock minute to UTC through the IANA zone, not UTC-4.
 * Trading sessions are outside the DST ambiguity at 01:00/02:00.
 */
export function usMinuteUTC(date: string, minute: number) {
  if (!validDate(date) || !Number.isInteger(minute) || minute < 0 || minute > 1440) throw new Error('无效的纽约日期或分钟');
  const desired = Date.parse(date + 'T00:00:00Z') + minute * 60000;
  let guess = desired;
  for (let attempt = 0; attempt < 3; attempt++) {
    const p = nyParts(new Date(guess));
    const represented = Date.parse(p.date + 'T00:00:00Z') + (p.hour * 60 + p.minute) * 60000;
    const delta = desired - represented;
    if (delta === 0) return guess;
    guess += delta;
  }
  throw new Error('无法解析纽约时区时间');
}
