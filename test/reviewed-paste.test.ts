import test from 'node:test';
import assert from 'node:assert/strict';
import {parseReviewedPaste,reviewedPasteHeader} from '../public/reviewed-paste.js';
test('reviewed paste keeps strategies, reference price, original time and both quotes',()=>{
 const text=reviewedPasteHeader+'\n一分钟改\t001270.SZ\tTEST\t2026-10-16T13:00:01\t83.95\t用户手动提供\t2026-10-16T12:59:56\t\t';
 // A final empty source column must survive parsing.
 const rows=parseReviewedPaste(text)!;assert.equal(rows.length,1);assert.equal(rows[0].original_time,'2026-10-16T12:59:56');assert.equal(rows[0].reference_price,'83.95');assert.equal(rows[0].reference_evidence.provider,'用户手动提供');
 assert.equal(parseReviewedPaste('300111.SZ 09:47'),null);assert.throws(()=>parseReviewedPaste(reviewedPasteHeader+'\na\tb'),/列数/);
});
