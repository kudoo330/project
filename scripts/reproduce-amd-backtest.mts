// node --import tsx scripts/reproduce-amd-backtest.mts /private/path/export.json
// Reads a private admin export. Does not connect to a broker, website or database.
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {runBacktest,ENGINE_VERSION} from '../src/amd-backtest';
import {researchDigest} from '../src/research-data-validation';
const path=process.argv[2];if(!path)throw new Error('Pass the private exported JSON path. Never commit real input data.');
const saved=JSON.parse(readFileSync(path,'utf8'));
assert.equal(saved.engineVersion,ENGINE_VERSION,'Use the exact engine version of the original run');
const input={minutes:saved.immutableInput.filter((p:any)=>p.kind==='minutes').flatMap((p:any)=>p.rows),daily:saved.immutableInput.filter((p:any)=>p.kind==='daily').flatMap((p:any)=>p.rows),minuteSource:saved.minuteSource,dailySource:saved.dailySource};
assert.equal(await researchDigest(input),saved.snapshotId,'Input snapshot digest mismatch');
const result=runBacktest(input,saved.config,saved.snapshotId);
assert.deepEqual(result.results,saved.results,'Historical events/metrics changed');
assert.deepEqual(result.quality,saved.quality);
console.log(JSON.stringify({ok:true,engine:ENGINE_VERSION,snapshot:saved.snapshotId,scenarioResults:result.results.length}));
