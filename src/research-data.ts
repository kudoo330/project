import type { Env } from './types';
import { csvCell } from './domain';
import {
  RESEARCH_MAX_ROWS, RESEARCH_STATUSES, normalizeResearchTime, validDate,
  validateResearchInput, researchDatasetId, researchDigest, planResearchRows, researchPreviewToken,
  type ResearchDatasetInput, type ResearchInput, type StoredResearchRow,
} from './research-data-validation';

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
const capabilities = { max_rows: RESEARCH_MAX_ROWS, max_body_bytes: 800_000, periods: ['1m', '1d'], symbols: ['AMD.US', 'AMDL.US'], statuses: RESEARCH_STATUSES, verification: 'manual_unverified', export_max_rows: 5000 };
type Dataset = ResearchDatasetInput & { id: string; revision: number; created_at: string; updated_at: string };
type DbBar = Omit<StoredResearchRow, 'time' | 'original_values'> & { time_key: string; original_values_json: string; verification: string; import_batch_id: string; updated_at: string };
type ImportBatch = { input_hash: string; counts_json: string; dataset_id: string; dataset_revision: number };
class InputError extends Error {}

async function readBody(request: Request) {
  const limit = capabilities.max_body_bytes;
  if (Number(request.headers.get('Content-Length') ?? 0) > limit) throw new InputError('请求超过800KB限制，请减少本批行数');
  const reader = request.body?.getReader();
  if (!reader) throw new InputError('缺少请求内容');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new InputError('请求超过800KB限制，请减少本批行数'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)); }
  catch { throw new InputError('需要有效的UTF-8 JSON内容'); }
}
const projectBar = (bar: DbBar) => {
  const { time_key, original_values_json, ...rest } = bar;
  return { ...rest, time: time_key, original_values: JSON.parse(original_values_json) };
};
async function datasetById(db: D1Database, id: string) {
  return db.prepare('SELECT * FROM research_market_datasets WHERE id=?').bind(id).first<Dataset>();
}
async function preview(db: D1Database, input: ResearchInput) {
  const id = await researchDatasetId(input.dataset);
  const [dataset, result] = await Promise.all([
    datasetById(db, id),
    db.prepare('SELECT * FROM research_market_bars WHERE dataset_id=? AND time_key IN (SELECT value FROM json_each(?)) ORDER BY time_key').bind(id, JSON.stringify(input.rows.map(row => row.time))).all<DbBar>(),
  ]);
  const existing = result.results.map(projectBar), revision = dataset?.revision ?? 0;
  const planned = planResearchRows(input, existing);
  return { valid: true, errors: [], dataset_id: id, dataset: input.dataset, revision,
    preview_token: await researchPreviewToken(input, revision, existing), ...planned, existing };
}
const publicPreview = ({ existing, ...value }: Awaited<ReturnType<typeof preview>>) => {
  const stored = new Map(existing.map(row => [row.time,row]));
  return { ...value, rows: value.rows.map(row => {
    if (!['conflict','blocked'].includes(row.action)) return row;
    const old = stored.get(row.time)!;
    const previous_value = Object.fromEntries(['open','high','low','close','volume','status','reason','source_note'].map(key=>[key,(old as any)[key]]));
    return { ...row, previous_value };
  }) };
};

async function deleteDataset(db: D1Database, id: string, value: any, actor: string) {
  if (!value || !/^[A-Za-z0-9_-]{16,80}$/.test(value.request_id ?? '') || !Number.isSafeInteger(value.expected_revision) || value.expected_revision < 1) throw new InputError('删除需有效请求ID和当前数据集版本');
  if (typeof value.reason !== 'string' || !value.reason.trim() || value.reason.length > 2000 || /[\u0000-\u001f]/.test(value.reason)) throw new InputError('删除需填写有效依据');
  const requestHash = await researchDigest({ id, expected_revision: value.expected_revision, reason: value.reason.trim() });
  const auditId = 'research-delete-' + value.request_id;
  const replay = async () => {
    const prior = await db.prepare('SELECT action,previous_value FROM audit WHERE id=?').bind(auditId).first<{action:string;previous_value:string}>();
    if (!prior) return null;
    const saved = JSON.parse(prior.previous_value);
    return prior.action === 'delete_research_dataset' && saved.request_hash === requestHash
      ? json({ ok:true, replayed:true, dataset_id:id, counts:saved.counts })
      : json({ error:'删除请求ID已用于其他内容', code:'request_id_conflict' },409);
  };
  const prior = await replay(); if (prior) return prior;
  const dataset = await datasetById(db,id);
  if (!dataset) return json({ error:'数据集不存在' },404);
  if (dataset.revision !== value.expected_revision) return json({ error:'数据集版本已变化，请刷新后再删除',code:'stale_dataset' },409);
  const counts: Record<string,number> = {};
  for (const table of ['research_market_bars','research_market_bar_revisions','research_market_import_batches']) counts[table] = (await db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE dataset_id=?`).bind(id).first<{n:number}>())!.n;
  const stamp = new Date().toISOString(), snapshot = { dataset, counts, reason:value.reason.trim(), request_hash:requestHash, deleted_at:stamp };
  const gate = 'EXISTS(SELECT 1 FROM audit WHERE id=?)';
  const references = `NOT EXISTS(SELECT 1 FROM research_annotations WHERE json_extract(reference_json,'$.dataset_id')=?)`;
  // One transaction gates every child deletion on a revision-checked audit
  // insertion. A stale request or a referenced source removes no rows.
  try {
    const result = await db.batch([
      db.prepare(`INSERT INTO audit(id,record_id,actor,action,previous_value,created_at) SELECT ?,?,?,'delete_research_dataset',?,? FROM research_market_datasets WHERE id=? AND revision=? AND ${references}`)
        .bind(auditId,id,actor,JSON.stringify(snapshot),stamp,id,value.expected_revision,id),
      ...['research_market_bar_revisions','research_market_bars','research_market_import_batches'].map(table=>db.prepare(`DELETE FROM ${table} WHERE dataset_id=? AND ${gate}`).bind(id,auditId)),
      db.prepare(`DELETE FROM research_market_datasets WHERE id=? AND revision=? AND ${gate}`).bind(id,value.expected_revision,auditId),
    ]);
    if (!result[0].meta.changes) return await replay() ?? json({ error:'数据集已变化或仍被研究标记引用，未删除任何数据',code:'dataset_delete_blocked' },409);
    return json({ ok:true, replayed:false, dataset_id:id, counts });
  } catch (error) { const saved = await replay(); if (saved) return saved; throw error; }
}

async function commit(db: D1Database, value: any, input: ResearchInput, actor: string) {
  if (typeof value.request_id !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(value.request_id)) throw new InputError('需要16至100位有效提交请求ID');
  if (!Number.isSafeInteger(value.expected_revision) || value.expected_revision < 0) throw new InputError('缺少有效的数据集版本，请重新预览');
  if (typeof value.preview_token !== 'string' || !/^[a-f0-9]{64}$/.test(value.preview_token)) throw new InputError('请先预览校验再导入');
  if (value.replace_conflicts !== undefined && typeof value.replace_conflicts !== 'boolean') throw new InputError('冲突替换选项必须为布尔值');
  const replacement = value.replace_conflicts === true;
  const replacementReason = typeof value.replace_reason === 'string' ? value.replace_reason.trim() : '';
  if (replacementReason.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(replacementReason)) throw new InputError('冲突替换依据无效或超过2000字');
  if (replacement && !replacementReason) throw new InputError('允许替换冲突时必须填写依据');
  const requestHash = await researchDigest({ input, expected_revision: value.expected_revision, preview_token: value.preview_token, replace_conflicts: replacement, replace_reason: replacementReason });
  const savedResult = async () => {
    const saved = await db.prepare('SELECT input_hash,counts_json,dataset_id,dataset_revision FROM research_market_import_batches WHERE id=?').bind(value.request_id).first<ImportBatch>();
    if (!saved) return null;
    return saved.input_hash === requestHash
      ? json({ ok: true, replayed: true, batch_id: value.request_id, dataset_id: saved.dataset_id, revision: saved.dataset_revision, counts: JSON.parse(saved.counts_json) })
      : json({ error: '此请求ID已用于其他导入内容，请重新预览', code: 'request_id_conflict' }, 409);
  };
  const prior = await savedResult(); if (prior) return prior;
  const checked = await preview(db, input);
  if (checked.revision !== value.expected_revision || checked.preview_token !== value.preview_token) return await savedResult() ?? json({ error: '数据或预览内容已变化，请重新预览后导入', code: 'stale_preview' }, 409);
  if (checked.counts.blocked) return json({ error: '已有有效价格不能被缺失状态覆盖；请移除这些行后重新预览', code: 'available_to_missing_blocked', counts: checked.counts }, 409);
  if (checked.counts.conflict && !replacement) return json({ error: '存在冲突，原数据保持不变；请核对后明确允许替换并填写依据', code: 'price_conflict', counts: checked.counts }, 409);
  const stamp = new Date().toISOString(), nextRevision = checked.revision + 1, d = input.dataset;
  const oldRows = new Map(checked.existing.map(row => [row.time, row]));
  const changes = checked.rows.filter(row => row.action !== 'unchanged').map(row => {
    const { action, ...bar } = row, previous = oldRows.get(row.time) ?? null;
    return { action, previous, row: bar, revision: (previous?.revision ?? 0) + 1 };
  });
  const changesJson = JSON.stringify(changes);
  // Previous source notes/raw values are repeated in each audit entry. Their
  // expanded size may exceed the incoming body limit; reject before any write.
  if (new TextEncoder().encode(changesJson).byteLength > 1_500_000) throw new InputError('本批修订记录过大，请减少行数并拆分为较小批次后重新预览');
  const gate = 'EXISTS(SELECT 1 FROM research_market_datasets d WHERE d.id=? AND d.revision=? AND d.last_import_id=?)';
  // D1 batch is atomic. The CAS owns a unique request_id; every following write
  // uses the same dataset revision + request_id gate, including audit and batch.
  const statements = [
    db.prepare(`INSERT INTO research_market_datasets(id,symbol,period,provider,adjustment,adjustment_as_of,time_zone,currency,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,0,?,?) ON CONFLICT(id) DO NOTHING`).bind(checked.dataset_id,d.symbol,d.period,d.provider,d.adjustment,d.adjustment_as_of,d.time_zone,d.currency,stamp,stamp),
    db.prepare('UPDATE research_market_datasets SET revision=revision+1,last_import_id=?,updated_at=? WHERE id=? AND revision=?').bind(value.request_id,stamp,checked.dataset_id,checked.revision),
    db.prepare(`INSERT INTO research_market_import_batches(id,dataset_id,input_hash,input_json,actor,source_note,replacement_reason,counts_json,dataset_revision,created_at) SELECT ?,?,?,?,?,?,?,?,?,? WHERE ${gate}`)
      .bind(value.request_id,checked.dataset_id,requestHash,JSON.stringify(input),actor,input.source_note,replacementReason,JSON.stringify(checked.counts),nextRevision,stamp,checked.dataset_id,nextRevision,value.request_id),
    db.prepare(`INSERT INTO research_market_bar_revisions(dataset_id,time_key,import_batch_id,actor,action,previous_value,new_value,source_note,replacement_reason,created_at)
      SELECT ?,json_extract(j.value,'$.row.time'),?,?,json_extract(j.value,'$.action'),json_extract(j.value,'$.previous'),json_extract(j.value,'$.row'),?,?,?
      FROM json_each(?) j WHERE ${gate}`)
      .bind(checked.dataset_id,value.request_id,actor,input.source_note,replacementReason,stamp,changesJson,checked.dataset_id,nextRevision,value.request_id),
    db.prepare(`INSERT INTO research_market_bars(dataset_id,time_key,original_time,trading_date,session,open,high,low,close,volume,status,reason,original_values_json,source_note,revision,import_batch_id,updated_at)
      SELECT ?,json_extract(j.value,'$.row.time'),json_extract(j.value,'$.row.original_time'),json_extract(j.value,'$.row.trading_date'),json_extract(j.value,'$.row.session'),
        json_extract(j.value,'$.row.open'),json_extract(j.value,'$.row.high'),json_extract(j.value,'$.row.low'),json_extract(j.value,'$.row.close'),json_extract(j.value,'$.row.volume'),
        json_extract(j.value,'$.row.status'),json_extract(j.value,'$.row.reason'),json_extract(j.value,'$.row.original_values'),?,json_extract(j.value,'$.revision'),?,?
      FROM json_each(?) j WHERE ${gate}
      ON CONFLICT(dataset_id,time_key) DO UPDATE SET original_time=excluded.original_time,trading_date=excluded.trading_date,session=excluded.session,
        open=excluded.open,high=excluded.high,low=excluded.low,close=excluded.close,volume=excluded.volume,status=excluded.status,reason=excluded.reason,
        original_values_json=excluded.original_values_json,source_note=excluded.source_note,revision=excluded.revision,import_batch_id=excluded.import_batch_id,updated_at=excluded.updated_at`)
      .bind(checked.dataset_id,input.source_note,value.request_id,stamp,changesJson,checked.dataset_id,nextRevision,value.request_id),
  ];
  let result: D1Result[];
  try { result = await db.batch(statements); }
  catch (error) {
    const saved = await savedResult(); if (saved) return saved;
    throw error;
  }
  if (!result[1].meta.changes) return await savedResult() ?? json({ error: '其他导入已修改数据，请重新预览；本次未写入行情', code: 'stale_preview' }, 409);
  return json({ ok: true, replayed: false, batch_id: value.request_id, dataset_id: checked.dataset_id, revision: nextRevision, counts: checked.counts }, 201);
}

function datasetParam(url: URL) {
  const id = url.searchParams.get('dataset_id') ?? '';
  if (!/^market_[a-f0-9]{64}$/.test(id)) throw new InputError('请选择有效的数据集');
  return id;
}
function rangeQuery(url: URL, dataset: Dataset) {
  const start = url.searchParams.get('start'), end = url.searchParams.get('end');
  const values: string[] = [dataset.id], clauses = ['dataset_id=?'];
  let dateMode = dataset.period === '1d';
  if (dataset.period === '1m') {
    const given = [start, end].filter((x): x is string => !!x);
    dateMode = given.every(x => validDate(x));
    if (given.some(x => validDate(x)) && !dateMode) throw new InputError('时间范围不能混用日期和ISO分钟时间');
  }
  const normalized = [start, end].map(value => {
    if (!value) return null;
    try { return dateMode ? normalizeResearchTime(value, '1d').time : normalizeResearchTime(value, dataset.period).time; }
    catch (error) { throw new InputError((error as Error).message); }
  });
  if (normalized[0] && normalized[1] && normalized[0] > normalized[1]) throw new InputError('开始时间不能晚于结束时间');
  for (let i = 0; i < 2; i++) if (normalized[i]) {
    clauses.push(`${dateMode ? 'trading_date' : 'time_key'}${i ? '<=' : '>='}?`); values.push(normalized[i]!);
  }
  return { where: clauses.join(' AND '), values };
}
async function readBars(db: D1Database, url: URL, exporting = false) {
  const id = datasetParam(url), dataset = await datasetById(db,id);
  if (!dataset) return json({ error: '数据集不存在' }, 404);
  const range = rangeQuery(url,dataset), values = [...range.values]; let where = range.where;
  const rawLimit = url.searchParams.get('limit') ?? '200', limit = exporting ? 5000 : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > (exporting ? 5000 : 500)) throw new InputError('每页支持1至500行');
  const cursor = url.searchParams.get('cursor');
  if (cursor && !exporting) {
    try { values.push(normalizeResearchTime(cursor,dataset.period).time); }
    catch { throw new InputError('分页游标无效'); }
    where += ' AND time_key>?';
  }
  const raw = (await db.prepare(`SELECT * FROM research_market_bars WHERE ${where} ORDER BY time_key LIMIT ?`).bind(...values,limit+1).all<DbBar>()).results;
  if (exporting) {
    if (raw.length > limit) return json({ error: '所选范围超过5000行，请缩小start/end日期范围后导出；没有截断文件' }, 413);
    const headers = ['time','open','high','low','close','volume','status','reason','symbol','period','provider','adjustment','adjustment_as_of','time_zone','currency','source_note','verification'];
    const lines = [headers.join(',')];
    for (const bar of raw) lines.push([bar.time_key,bar.open,bar.high,bar.low,bar.close,bar.volume,bar.status,bar.reason,dataset.symbol,dataset.period,dataset.provider,dataset.adjustment,dataset.adjustment_as_of,dataset.time_zone,dataset.currency,bar.source_note,bar.verification].map(csvCell).join(','));
    return new Response('\ufeff'+lines.join('\r\n'),{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="${dataset.symbol}-${dataset.period}.csv"`,'Cache-Control':'no-store'}});
  }
  const rows = raw.slice(0,limit).map(projectBar);
  const statusCounts = (await db.prepare(`SELECT status,COUNT(*) AS count FROM research_market_bars WHERE ${range.where} GROUP BY status`).bind(...range.values).all<{status:string;count:number}>()).results;
  const counts = Object.fromEntries(statusCounts.map(row=>[row.status,row.count]));
  return json({ dataset, bars: rows, next_cursor: raw.length > limit ? rows[rows.length-1].time : null, counts,
    coverage: { status: 'partial_or_unassessed', known_rows: statusCounts.reduce((n,r)=>n+r.count,0), note: '仅统计已保存行；未提供的分钟保持未知，未验证完整交易日历或独立行情来源' } });
}

/** Caller must authenticate admin and enforce Origin/JSON on every write. */
export async function researchDataApi(request: Request, env: Env, url: URL, actor: string): Promise<Response> {
  try {
    const path = url.pathname.slice('/api/research-data'.length);
    const deletion = path.match(/^\/datasets\/(market_[a-f0-9]{64})$/);
    if (request.method === 'DELETE' && deletion) return await deleteDataset(env.DB,deletion[1],await readBody(request),actor);
    if (request.method === 'GET' && path === '/datasets') {
      const datasets = (await env.DB.prepare(`SELECT d.*,COUNT(b.time_key) AS row_count,
        COALESCE(SUM(b.status='available'),0) AS available_count,COALESCE(SUM(b.status<>'available'),0) AS missing_count,
        MIN(b.time_key) AS first_time,MAX(b.time_key) AS last_time
        FROM research_market_datasets d LEFT JOIN research_market_bars b ON b.dataset_id=d.id GROUP BY d.id ORDER BY d.updated_at DESC,d.id LIMIT 201`).all()).results;
      return json({ datasets: datasets.slice(0,200), truncated: datasets.length>200, capabilities });
    }
    if (request.method === 'GET' && path === '/bars') return await readBars(env.DB,url);
    if (request.method === 'GET' && path === '/export') return await readBars(env.DB,url,true);
    if (request.method === 'POST' && ['/preview','/import'].includes(path)) {
      const value = await readBody(request), checked = validateResearchInput(value);
      if (!checked.input) return json({ valid: false, error: '导入内容未通过校验', errors: checked.errors }, path === '/preview' ? 200 : 400);
      if (path === '/preview') return json(publicPreview(await preview(env.DB,checked.input)));
      return await commit(env.DB,value,checked.input,actor);
    }
    return json({ error: '研究数据接口或方法不存在' }, 404);
  } catch (error) {
    if (error instanceof InputError) return json({ error: error.message },400);
    return json({ error: '研究行情存储暂不可用，请确认数据库迁移已完成后重试', code: 'research_storage_unavailable' },503);
  }
}
