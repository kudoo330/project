import dates from './calendar.json';
import type {RecordRow} from './types';
export function afterBuyWindow(record:RecordRow){const i=dates.indexOf(record.buy_time.slice(0,10));return i<0||record.symbol.endsWith('.BJ')?[]:dates.slice(i+1,i+11);}

// D0 is collected separately; it does not consume the ten after-buy trading days.
export function collectionWindow(record:RecordRow){const after=afterBuyWindow(record);return [record.buy_time.slice(0,10),...after];}
