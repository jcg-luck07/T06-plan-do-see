// 모든 /api/* 요청을 처리합니다.
const { getDb } = require('./db');

const TODAY_SEOUL = "(now() at time zone 'Asia/Seoul')::date";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (m) => new HttpError(400, m);

// ---------- 입력 검사 ----------
function str(v, name, { max = 300, required = false } = {}) {
  const s = v === undefined || v === null ? '' : String(v).trim();
  if (required && !s) throw bad(`${name}을(를) 입력하세요.`);
  if (s.length > max) throw bad(`${name}은(는) ${max}자 이하로 적어 주세요.`);
  return s;
}
function date(v, name, { required = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw bad(`${name}을(를) 입력하세요.`);
    return null;
  }
  if (!DATE_RE.test(String(v)) || Number.isNaN(Date.parse(v))) throw bad(`${name}은(는) YYYY-MM-DD 형식이어야 합니다.`);
  return String(v);
}
function int(v, name, { min = 0, max = 100000, def = 0 } = {}) {
  if (v === undefined || v === null || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`${name}은(는) ${min}~${max} 사이의 정수여야 합니다.`);
  return n;
}
function prio(v) {
  return int(v, '우선순위', { min: 1, max: 3, def: 2 });
}
function tags(v) {
  const arr = (Array.isArray(v) ? v : String(v ?? '').split(','))
    .map((t) => String(t).trim().toLowerCase())
    .filter(Boolean);
  const uniq = [...new Set(arr)];
  if (uniq.length > 10) throw bad('태그는 10개까지 넣을 수 있습니다.');
  if (uniq.some((t) => t.length > 30)) throw bad('태그 하나는 30자 이하여야 합니다.');
  return uniq.join(',');
}
// 시각: 시간대 표시가 없으면 서울(+09:00)로 봅니다.
function instant(v, name) {
  if (!v) throw bad(`${name}을(를) 입력하세요.`);
  let s = String(v).trim();
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(s)) s += s.length === 16 ? ':00+09:00' : '+09:00';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw bad(`${name} 형식이 올바르지 않습니다.`);
  return d.toISOString();
}
function idParam(s) {
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1 || n > 2147483647) throw bad('번호가 올바르지 않습니다.');
  return n;
}

// ---------- 공통 SQL 조각 ----------
// 계획과 할 일은 같은 것: tasks 표의 한 줄이 계획(할 일) 하나입니다.
const TASK_COLS = `t.id, t.title, t.start_date::text as start_date, t.due_date::text as due_date, t.priority, t.tags,
  t.success_criteria, t.estimated_minutes, t.status, t.done_at, t.carried_lesson, t.carried_from_review_id, t.created_at,
  coalesce((select sum(r.actual_minutes) from runs r where r.task_id = t.id), 0)::int as actual_minutes,
  (select count(*) from runs r where r.task_id = t.id)::int as run_count,
  exists (select 1 from runs r where r.task_id = t.id and btrim(r.blocked_reason) <> '') as blocked,
  (select r.blocked_reason from runs r where r.task_id = t.id and btrim(r.blocked_reason) <> ''
     order by r.started_at desc, r.id desc limit 1) as last_blocked_reason,
  (t.status <> 'done' and t.due_date is not null and t.due_date < ${TODAY_SEOUL}) as late`;

const SORTS = {
  due: ['t.due_date', 'asc nulls last'],
  priority: ['t.priority', 'asc'],
  estimate: ['t.estimated_minutes', 'asc'],
  created: ['t.created_at', 'asc'],
  title: ['t.title', 'asc'],
};

// ---------- 계획(할 일) 입력 ----------
function taskInput(b) {
  const due = date(b.due_date, '마감일');
  const f = {
    title: str(b.title, '계획(할 일) 이름', { required: true, max: 150 }),
    start_date: date(b.start_date, '시작일') || due, // 시작일을 비우면 마감일과 같은 날
    due_date: due,
    priority: prio(b.priority),
    tags: tags(b.tags),
    success_criteria: str(b.success_criteria, '성공 기준', { max: 500 }),
    estimated_minutes: int(b.estimated_minutes, '예상 시간(분)', { max: 600000 }),
  };
  if (f.start_date && f.due_date && f.due_date < f.start_date) throw bad('마감일은 시작일보다 빠를 수 없습니다.');
  return f;
}

// 새로 만들면서 '처음 세운 계획'(버전 1)을 같은 문장 안에서 함께 남깁니다.
async function insertTask(db, f, extra = {}) {
  const rows = await db.query(
    `with t as (
       insert into tasks (title, start_date, due_date, priority, tags, success_criteria, estimated_minutes, carried_lesson, carried_from_review_id)
       values ($1, $2::date, $3::date, $4, $5, $6, $7, $8, $9) returning *
     ), r as (
       insert into task_revisions (task_id, version, title, start_date, due_date, priority, tags, success_criteria, estimated_minutes, change_note)
       select id, 1, title, start_date, due_date, priority, tags, success_criteria, estimated_minutes, '처음 세운 계획' from t
       returning task_id
     ) select id from t`,
    [f.title, f.start_date, f.due_date, f.priority, f.tags, f.success_criteria, f.estimated_minutes,
      extra.carried_lesson ?? null, extra.carried_from_review_id ?? null]);
  return rows[0].id;
}

// 고칠 때는 현재 값만 바꾸고, 바꾼 뒤의 값을 새 버전으로 이력에 더합니다. 버전 1(처음 계획)은 그대로입니다.
async function updateTask(db, id, b) {
  const f = taskInput(b);
  const note = str(b.change_note, '고친 이유', { max: 300 });
  const rows = await db.query(
    `with u as (
       update tasks set title=$2, start_date=$3::date, due_date=$4::date, priority=$5, tags=$6,
         success_criteria=$7, estimated_minutes=$8, updated_at=now()
       where id=$1 and deleted_at is null returning *
     ), r as (
       insert into task_revisions (task_id, version, title, start_date, due_date, priority, tags, success_criteria, estimated_minutes, change_note)
       select u.id, (select coalesce(max(version),0)+1 from task_revisions where task_id=u.id),
         u.title, u.start_date, u.due_date, u.priority, u.tags, u.success_criteria, u.estimated_minutes, $9
       from u returning task_id
     ) select id from u`,
    [id, f.title, f.start_date, f.due_date, f.priority, f.tags, f.success_criteria, f.estimated_minutes, note]);
  if (!rows.length) throw new HttpError(404, '계획(할 일)을 찾을 수 없습니다.');
}

function taskFilterSql(q, params) {
  const where = ['t.deleted_at is null'];
  const add = (sql, v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
  if (q.q) add("position(lower(?::text) in lower(t.title || ' ' || t.tags)) > 0", String(q.q).slice(0, 100));
  if (q.status === 'doing' || q.status === 'done') add('t.status = ?', q.status);
  if (q.priority) add('t.priority = ?::int', prio(q.priority));
  if (q.tag) add("?::text = any(string_to_array(t.tags, ','))", String(q.tag).trim().toLowerCase());
  if (q.late === '1') where.push(`(t.status <> 'done' and t.due_date is not null and t.due_date < ${TODAY_SEOUL})`);
  if (q.blocked === '1') where.push("exists (select 1 from runs r where r.task_id = t.id and btrim(r.blocked_reason) <> '')");
  if (q.from) add('t.due_date >= ?::date', date(q.from, '시작 날짜'));
  if (q.to) add('t.due_date <= ?::date', date(q.to, '끝 날짜'));
  return where.join(' and ');
}

async function listTasks(db, q) {
  const params = [];
  const where = taskFilterSql(q, params);
  const [col, defDir] = SORTS[q.sort] || SORTS.due;
  let order = `${col} ${defDir}`;
  if (q.dir === 'desc') order = `${col} ${defDir.includes('nulls') ? 'desc nulls last' : 'desc'}`;
  // 값이 같으면 번호(id) 순 → 볼 때마다 순서가 달라지지 않음
  return db.query(`select ${TASK_COLS} from tasks t where ${where} order by ${order}, t.id asc`, params);
}

async function getTask(db, id) {
  const [task] = await db.query(`select ${TASK_COLS} from tasks t where t.id = $1 and t.deleted_at is null`, [id]);
  if (!task) throw new HttpError(404, '계획(할 일)을 찾을 수 없습니다.');
  task.runs = await db.query(
    `select id, task_id, started_at, ended_at, actual_minutes, blocked_reason, created_at
     from runs where task_id = $1 order by started_at, id`, [id]);
  task.revisions = await db.query(
    `select version, title, start_date::text as start_date, due_date::text as due_date, priority, tags,
      success_criteria, estimated_minutes, change_note, changed_at
     from task_revisions where task_id = $1 order by version`, [id]);
  return task;
}

async function completeTask(db, id, b) {
  const key = str(b.idempotency_key, '요청 키', { required: true, max: 100 });
  // 한 문장으로 처리: 같은 키이거나 이미 완료 기록이 있으면 새로 쌓지 않음 (DB 제약이 최종 방어선)
  const rows = await db.query(
    `with t as (select id from tasks where id = $1 and deleted_at is null),
     ins as (
       insert into completions (task_id, idempotency_key)
       select id, $2 from t
       on conflict do nothing
       returning id
     ),
     upd as (
       update tasks set status = 'done', done_at = coalesce(done_at, now()), updated_at = now()
       where id in (select id from t) returning id
     )
     select (select count(*) from ins)::int as created, (select count(*) from t)::int as found`,
    [id, key]);
  if (!rows[0].found) throw new HttpError(404, '계획(할 일)을 찾을 수 없습니다.');
  return { created: rows[0].created === 1, task: await getTask(db, id) };
}

async function reopenTask(db, id) {
  const rows = await db.query(
    `with t as (select id from tasks where id = $1 and deleted_at is null),
     c as (update completions set reverted_at = now() where task_id in (select id from t) and reverted_at is null returning id),
     u as (update tasks set status = 'doing', done_at = null, updated_at = now() where id in (select id from t) returning id)
     select (select count(*) from t)::int as found`, [id]);
  if (!rows[0].found) throw new HttpError(404, '계획(할 일)을 찾을 수 없습니다.');
  return getTask(db, id);
}

// ---------- 실행 기록 ----------
async function addRun(db, taskId, b) {
  const started = instant(b.started_at, '시작 시각');
  const ended = instant(b.ended_at, '끝난 시각');
  if (ended < started) throw bad('끝난 시각은 시작 시각보다 빠를 수 없습니다.');
  const diff = Math.round((Date.parse(ended) - Date.parse(started)) / 60000);
  const minutes = b.actual_minutes === undefined || b.actual_minutes === '' || b.actual_minutes === null
    ? diff : int(b.actual_minutes, '실제 걸린 시간(분)', { max: 600000 });
  const reason = str(b.blocked_reason, '막혔던 이유', { max: 500 });
  const key = b.idempotency_key ? str(b.idempotency_key, '요청 키', { max: 100 }) : null;
  const [task] = await db.query('select id from tasks where id = $1 and deleted_at is null', [taskId]);
  if (!task) throw new HttpError(404, '계획(할 일)을 찾을 수 없습니다.');
  const rows = await db.query(
    `insert into runs (task_id, started_at, ended_at, actual_minutes, blocked_reason, idempotency_key)
     values ($1, $2::timestamptz, $3::timestamptz, $4, $5, $6)
     on conflict (idempotency_key) do nothing returning id`,
    [taskId, started, ended, minutes, reason, key]);
  return { created: rows.length === 1, task: await getTask(db, taskId) };
}

// ---------- 돌아보기 ----------
async function computeReview(db, q) {
  const params = [];
  const where = taskFilterSql({ from: q.from, to: q.to }, params);
  const [r] = await db.query(
    `with base as (select t.* from tasks t where ${where})
     select
       count(*)::int as planned,
       (count(*) filter (where status = 'done'))::int as done,
       (count(*) filter (where status <> 'done' and due_date is not null and due_date < ${TODAY_SEOUL}))::int as late,
       (count(*) filter (where exists (select 1 from runs r where r.task_id = base.id and btrim(r.blocked_reason) <> '')))::int as blocked,
       coalesce(sum(estimated_minutes), 0)::int as estimated_minutes,
       coalesce((select sum(r.actual_minutes) from runs r where r.task_id in (select id from base)), 0)::int as actual_minutes
     from base`, params);
  return { ...r, diff_minutes: r.actual_minutes - r.estimated_minutes };
}

async function carryOver(db, b) {
  const lesson = str(b.lesson, '고칠 점', { required: true, max: 300 });
  const from = date(b.from, '시작 날짜');
  const to = date(b.to, '끝 날짜');
  const snapshot = await computeReview(db, { from, to });
  const next = taskInput({
    title: b.next_title || `다음 계획: ${lesson}`.slice(0, 150),
    start_date: b.next_start_date,
    due_date: b.next_due_date,
    priority: b.next_priority,
    tags: b.next_tags,
    success_criteria: b.next_success_criteria || `지난 돌아보기에서 정한 고칠 점을 지킨다: ${lesson}`.slice(0, 500),
    estimated_minutes: b.next_estimated_minutes,
  });
  const [rev] = await db.query(
    `insert into reviews (period_from, period_to, snapshot, lesson)
     values ($1::date, $2::date, $3::jsonb, $4) returning id`,
    [from, to, JSON.stringify(snapshot), lesson]);
  const nextId = await insertTask(db, next, { carried_lesson: lesson, carried_from_review_id: rev.id });
  await db.query('update reviews set next_task_id = $1 where id = $2', [nextId, rev.id]);
  return { review_id: rev.id, next_task_id: nextId };
}

async function listReviews(db) {
  return db.query(
    `select id, period_from::text as period_from, period_to::text as period_to,
      snapshot, lesson, next_task_id, created_at from reviews order by id desc`);
}

// ---------- 내보내기 ----------
async function exportAll(db) {
  const t = (name) => db.query(`select * from ${name} order by id`);
  return {
    format: 'pds-export-v2',
    exported_at: new Date().toISOString(),
    timezone: 'Asia/Seoul (날짜는 서울 기준, 시각은 UTC ISO 8601)',
    units: { time: '분(minute)' },
    tasks: await t('tasks'),
    task_revisions: await t('task_revisions'),
    completions: await t('completions'),
    runs: await t('runs'),
    reviews: await t('reviews'),
  };
}

// ---------- 길 찾기 ----------
async function route(db, method, parts, q, body) {
  const [a, b, c] = parts;
  if (a === 'health') return { ok: true, db: db.kind };
  if (a === 'today') {
    const [r] = await db.query(`select ${TODAY_SEOUL}::text as today`);
    return r;
  }
  if (a === 'tasks') {
    if (!b && method === 'GET') return listTasks(db, q);
    if (!b && method === 'POST') return getTask(db, await insertTask(db, taskInput(body)));
    if (b && !c && method === 'GET') return getTask(db, idParam(b));
    if (b && !c && method === 'PUT') { await updateTask(db, idParam(b), body); return getTask(db, idParam(b)); }
    if (b && !c && method === 'DELETE') {
      const rows = await db.query(
        'update tasks set deleted_at = now() where id = $1 and deleted_at is null returning id', [idParam(b)]);
      if (!rows.length) throw new HttpError(404, '계획(할 일)을 찾을 수 없습니다.');
      return { deleted: true };
    }
    if (b && c === 'complete' && method === 'POST') return completeTask(db, idParam(b), body);
    if (b && c === 'reopen' && method === 'POST') return reopenTask(db, idParam(b));
    if (b && c === 'runs' && method === 'POST') return addRun(db, idParam(b), body);
  }
  if (a === 'review' && !b && method === 'GET') return computeReview(db, q);
  if (a === 'review' && b === 'carry' && method === 'POST') return carryOver(db, body);
  if (a === 'reviews' && method === 'GET') return listReviews(db);
  if (a === 'export' && method === 'GET') return { __download: await exportAll(db) };
  throw new HttpError(404, '없는 주소입니다.');
}

// ---------- 입출력 ----------
async function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') return req.body ? JSON.parse(req.body) : {};
    return req.body;
  }
  const chunks = [];
  let size = 0;
  for await (const ch of req) {
    size += ch.length;
    if (size > 100000) throw bad('요청이 너무 큽니다.');
    chunks.push(ch);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function send(res, status, data, headers = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(data));
}

module.exports = async function handler(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
    const q = Object.fromEntries(url.searchParams);
    let body = {};
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      try { body = await readBody(req); } catch (e) {
        if (e instanceof HttpError) throw e;
        throw bad('요청 내용을 읽을 수 없습니다.');
      }
    }
    const db = await getDb();
    const result = await route(db, req.method, parts, q, body);
    if (result && result.__download) {
      return send(res, 200, result.__download, {
        'Content-Disposition': 'attachment; filename="plan-do-see-export.json"',
      });
    }
    send(res, 200, result);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error('서버 오류:', e && e.code, e && e.message);
    send(res, 500, { error: '서버에서 문제가 생겼습니다. 잠시 뒤 다시 시도해 주세요.' });
  }
};
