import dates from './calendar.json';
import type {RecordRow} from './types';
export function afterBuyWindow(record:RecordRow){const i=dates.indexOf(record.buy_time.slice(0,10));return i<0||record.symbol.endsWith('.BJ')?[]:dates.slice(i+1,i+11);}
