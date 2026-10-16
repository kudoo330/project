export function sortRecords<T extends {id:string;buy_time:string;tracking?:{window?:Array<{value:number|null}>}}>(records:T[],field?:string,direction?:string):T[];
