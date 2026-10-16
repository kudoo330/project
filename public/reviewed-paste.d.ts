export const reviewedPasteHeader:string;
export function parseReviewedPaste(text:string):null|Array<{strategy:string;symbol:string;name:string;buy_time:string;original_time:string;reference_price:string|null;reference_evidence:Record<string,unknown>}>;
