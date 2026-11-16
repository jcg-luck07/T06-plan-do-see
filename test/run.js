// 자동 검사: 과제 통과 기준(T06-C04~C36)을 서버에 직접 확인합니다.
// 임시 폴더의 시험용 DB만 사용하므로 내 진짜 자료에는 영향이 없습니다.
const os = require('os');
const fs = require('fs');
const path = require('path');

delete process.env.DATABASE_URL; // 시험은 항상 임시 DB로
process.env.LOCAL_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pds-test-'));
const server = require('../server');

let pass = 0, fail = 0;
const ok = (cond, name) => { cond ? pass++ : fail++; console.log(`${cond ? '통과' : '실패'}  ${name}`); };

async function main() {
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}/api/`;
  const call = async (p, method = 'GET', body) => {
    const res = await fetch(base + p, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json() };
  };

  // ---- 카드 1+2: 계획(할 일) — 계획과 할 일은 같은 것 ----
  const T = {};
  const mk = async (k, body) => { T[k] = (await call('tasks', 'POST', body)).data; };
  await mk('a', { title: '알파 <script>alert(1)</script>', start_date: '2019-12-01', due_date: '2020-01-01', priority: 1, tags: 'Study, 코딩', success_criteria: '카드 5개 완료', estimated_minutes: 60 });
  await mk('b', { title: '베타', due_date: '2099-01-01', priority: 2, tags: 'gym', estimated_minutes: 30 });
  await mk('c', { title: '감마', due_date: '2099-01-01', priority: 3, tags: 'study', estimated_minutes: 90 });
  await mk('d', { title: '델타', priority: 1, tags: '', estimated_minutes: 20 });
  await mk('e', { title: '엡실론', due_date: '2020-02-02', priority: 2, tags: 'study', estimated_minutes: 45 });
  ok((await call('plans')).status === 404, '계획 표/주소가 따로 없다 (계획 = 할 일, 하나로 통합)');
  ok(T.a.start_date === '2019-12-01' && T.a.due_date === '2020-01-01', 'C04 계획에 기간(시작~마감)이 저장된다');
  ok(T.a.priority === 1, 'C05 계획에 우선순위가 저장된다');
  ok(T.a.success_criteria === '카드 5개 완료', 'C06 계획에 성공 기준이 저장된다');
  ok(T.a.estimated_minutes === 60, 'C07 계획에 예상 시간이 저장된다');
  ok(T.b.start_date === '2099-01-01', '시작일을 비우면 마감일과 같은 날로 저장된다');
  ok((await call('tasks', 'POST', { title: 'x', start_date: '2026-12-01', due_date: '2026-11-01' })).status === 400, '잘못된 기간(마감<시작)은 거절된다');
  ok(T.a.id > 0 && T.a.title.includes('<script>'), 'C09 계획(할 일)을 만들 수 있다 (스크립트 글자는 글자 그대로 저장)');
  const edited = (await call('tasks/' + T.a.id, 'PUT', { title: '알파2 <script>alert(1)</script>', start_date: '2019-12-01', due_date: '2020-01-01', priority: 1, tags: 'Study, 코딩', success_criteria: '카드 5개 + 점검', estimated_minutes: 90, change_note: '예상 시간 늘림' })).data;
  ok(edited.id === T.a.id && edited.title.startsWith('알파2') && edited.estimated_minutes === 90, 'C08 ID는 그대로, 현재 값은 바뀐다');
  ok(edited.revisions.length === 2 && edited.revisions[0].title.startsWith('알파 ') && edited.revisions[0].estimated_minutes === 60 && edited.revisions[0].success_criteria === '카드 5개 완료' && edited.revisions[0].start_date === '2019-12-01', 'C08 고치기 전 처음 계획이 이력에 그대로 남는다');
  ok(edited.revisions[1].change_note === '예상 시간 늘림' && edited.revisions[1].estimated_minutes === 90, '고친 값과 이유도 이력에 쌓인다');
  T.a = edited;
  const upd = (await call('tasks/' + T.b.id, 'PUT', { title: '베타(수정)', due_date: '2099-01-01', priority: 2, tags: 'gym', estimated_minutes: 35 })).data;
  ok(upd.title === '베타(수정)' && upd.estimated_minutes === 35, 'C10 할 일을 고칠 수 있다');
  ok(T.a.due_date === '2020-01-01', 'C14 마감일이 저장된다');
  ok(T.a.priority === 1, 'C15 우선순위가 저장된다');
  ok(T.a.tags === 'study,코딩', 'C16 태그가 저장된다 (소문자·쉼표 정리)');
  ok(T.a.estimated_minutes === 90, 'C17 예상 시간이 저장된다 (고친 뒤 현재 값)');
  const search = (await call('tasks?q=' + encodeURIComponent('감마'))).data;
  ok(search.length === 1 && search[0].id === T.c.id, 'C18 할 일을 검색할 수 있다');
  const byTag = (await call('tasks?tag=study')).data;
  ok(byTag.length === 3, 'C19 태그로 거를 수 있다');
  ok((await call('tasks?priority=1')).data.length === 2, 'C19 우선순위로 거를 수 있다');
  const byDue = (await call('tasks?sort=due')).data.map((t) => t.id);
  const expected = [T.a.id, T.e.id, T.b.id, T.c.id, T.d.id]; // 마감일 빠른 순, 같으면 ID, 없으면 맨 뒤
  ok(JSON.stringify(byDue) === JSON.stringify(expected), 'C20 마감일 순 정렬 (같으면 ID순, 마감일 없음은 맨 뒤)');
  const again = (await call('tasks?sort=due')).data.map((t) => t.id);
  ok(JSON.stringify(again) === JSON.stringify(byDue), 'C20 같은 요청은 항상 같은 순서');
  const byPrio = (await call('tasks?sort=priority')).data.map((t) => t.id);
  ok(JSON.stringify(byPrio) === JSON.stringify([T.a.id, T.d.id, T.b.id, T.e.id, T.c.id]), 'C20 우선순위 순 정렬 (같으면 ID순)');
  ok((await call('tasks?late=1')).data.length === 2, '지연 거르기: 마감이 지난 미완료 2개');

  // ---- 카드 3: 완료·기록 ----
  const key = 'same-click-' + Date.now();
  const [r1, r2] = await Promise.all([
    call(`tasks/${T.a.id}/complete`, 'POST', { idempotency_key: key }),
    call(`tasks/${T.a.id}/complete`, 'POST', { idempotency_key: key }),
  ]);
  const [r3, r4] = await Promise.all([
    call(`tasks/${T.e.id}/complete`, 'POST', { idempotency_key: 'k-1' }),
    call(`tasks/${T.e.id}/complete`, 'POST', { idempotency_key: 'k-2' }), // 키가 달라도 (버튼 연타)
  ]);
  const created1 = [r1, r2].filter((r) => r.data.created).length;
  const created2 = [r3, r4].filter((r) => r.data.created).length;
  ok(created1 === 1 && created2 === 1, 'C21 연달아 두 번 눌러도 완료 기록은 한 건만 생긴다 (같은 키·다른 키 모두)');
  const exp = (await call('export')).data;
  ok(exp.completions.filter((c) => c.task_id === T.a.id && !c.reverted_at).length === 1 && exp.completions.filter((c) => c.task_id === T.e.id && !c.reverted_at).length === 1, 'C21 DB에 완료 기록이 각각 1건');
  const rv = (await call('review')).data;
  ok(rv.done === 2, 'C22 돌아보기의 완료 수는 정확히 2 (두 번 누른 일 2개 → 각 1씩)');
  const reopened = (await call(`tasks/${T.e.id}/reopen`, 'POST', {})).data;
  ok(reopened.status === 'doing', 'C12 완료한 할 일을 진행 중으로 되돌릴 수 있다');
  ok((await call(`tasks/${T.e.id}/complete`, 'POST', { idempotency_key: 'k-3' })).data.created === true, '되돌린 뒤에는 다시 완료할 수 있다');
  ok((await call(`tasks/${T.e.id}/reopen`, 'POST', {})).data.status === 'doing', 'C11/C12 완료 ↔ 진행 중 오가기');

  const before = (await call('tasks/' + T.a.id)).data;
  const runBody = { started_at: '2026-11-10T09:00', ended_at: '2026-11-10T10:30', blocked_reason: '자료가 부족했다', idempotency_key: 'run-1' };
  const run = (await call(`tasks/${T.a.id}/runs`, 'POST', runBody)).data;
  const run2 = (await call(`tasks/${T.a.id}/runs`, 'POST', runBody)).data;
  const after = run2.task;
  ok(run.task.runs[0].started_at === '2026-11-10T00:00:00.000Z' || /2026-11-10T00:00/.test(JSON.stringify(run.task.runs[0].started_at)), 'C23 실행 기록에 시작 시각이 저장된다 (서울 09:00 = UTC 00:00)');
  ok(/2026-11-10T01:30/.test(JSON.stringify(run.task.runs[0].ended_at)), 'C24 실행 기록에 끝난 시각이 저장된다');
  ok(run.task.runs[0].actual_minutes === 90, 'C25 실제로 걸린 시간이 저장된다 (분)');
  ok(run.task.runs[0].blocked_reason === '자료가 부족했다', 'C26 막혔던 이유가 저장된다');
  ok(after.estimated_minutes === before.estimated_minutes && after.due_date === before.due_date && after.priority === before.priority && after.title === before.title, 'C27 기록을 저장해도 원래 계획 값은 덮어쓰이지 않는다');
  ok(after.runs.length === 1, '같은 기록 요청을 두 번 보내도 기록은 한 건');
  await call(`tasks/${T.b.id}/runs`, 'POST', { started_at: '2026-11-11T10:00', ended_at: '2026-11-11T10:45' });
  await call(`tasks/${T.c.id}/runs`, 'POST', { started_at: '2026-11-12T10:00', ended_at: '2026-11-12T12:00', actual_minutes: 100, blocked_reason: '   ' });

  // ---- 카드 4: 돌아보기 ----
  const rev = (await call('review')).data;
  const list = (await call('tasks')).data;
  ok(rev.planned === 5 && rev.planned === list.length, 'C28 계획 수 = 지우지 않은 할 일 수');
  ok(rev.done === list.filter((t) => t.status === 'done').length, 'C29 완료 수 = 완료 상태 할 일 수');
  ok(rev.late === 1 && rev.late === (await call('tasks?late=1')).data.length, 'C30 지연 수 = 미완료이고 마감이 오늘보다 앞선 수 (완료한 것은 안 셈)');
  ok(rev.blocked === 1, 'C31 막힘 수 = 막힌 이유가 적힌 할 일 수 (공백만 적은 건 제외)');
  const estSum = list.reduce((s, t) => s + t.estimated_minutes, 0);
  ok(rev.estimated_minutes === estSum && rev.actual_minutes === 90 + 45 + 100 && rev.diff_minutes === rev.actual_minutes - rev.estimated_minutes, 'C32 예상·실제·차이(실제−예상) 계산');
  const empty = (await call('review?from=1999-01-01&to=1999-01-02')).data;
  ok(empty.planned === 0 && empty.estimated_minutes === 0 && empty.actual_minutes === 0 && empty.diff_minutes === 0, 'C32 아무것도 없으면 전부 0');
  ok((await call('tasks?blocked=1')).data.map((t) => t.id).join() === String(T.a.id), 'C83 막힘 숫자를 눌러 간 목록 = 막힌 할 일 (근거 기록으로 이동 가능)');
  const carry = (await call('review/carry', 'POST', { lesson: '예상 시간을 1.5배로 잡는다', next_start_date: '2026-12-06', next_due_date: '2026-12-12', next_estimated_minutes: 300 })).data;
  const nextPlan = (await call('tasks/' + carry.next_task_id)).data;
  ok(nextPlan.carried_lesson === '예상 시간을 1.5배로 잡는다' && nextPlan.carried_from_review_id === carry.review_id && nextPlan.due_date === '2026-12-12' && nextPlan.revisions.length === 1, 'C33 고칠 점 한 건이 다음 계획(새 계획 한 줄)으로 넘어간다');
  ok((await call('reviews')).data[0].snapshot.planned === 5, '돌아보기 숫자가 DB에 저장된다');

  // ---- 삭제 ----
  await call('tasks/' + T.d.id, 'DELETE');
  ok((await call('tasks/' + T.d.id)).status === 404 && (await call('tasks')).data.length === 5, 'C13 할 일을 지울 수 있다 (목록·돌아보기에서 빠짐)');
  ok((await call('review')).data.planned === 5, 'C28 지운 할 일은 계획 수에서 빠진다');

  // ---- 카드 5: 저장·내보내기·안전 ----
  const exp2 = (await call('export')).data;
  ok(exp2.tasks.length === 6 && exp2.task_revisions.length >= 7 && exp2.runs.length === 3 && exp2.reviews.length === 1, 'C36 내보내기에 계획·할 일·기록·돌아보기가 전부 들어 있다');
  ok(exp2.tasks.find((t) => t.id === T.a.id).title.includes('<script>'), 'C57 스크립트 모양 글자가 글자 그대로 저장된다');
  ok(!/postgres(ql)?:\/\//i.test(JSON.stringify(exp2)), 'C58 응답에 DB 접속 주소가 없다');
  const html = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(html), 'C57 화면 코드는 글을 HTML로 넣지 않는다 (textContent만 사용)');
  const page = await (await fetch(`http://localhost:${server.address().port}/`)).text();
  ok(page.includes('지금은 로그인이 없어 링크를 아는 사람은 누구나 볼 수 있습니다. 남이 봐도 괜찮은 내용만 넣으세요'), 'C82 첫 화면에 공개 안내 문구가 있다');
  ok((await call('tasks', 'POST', { title: '', due_date: 'x' })).status === 400, '빈 값/잘못된 값은 400으로 거절');

  console.log(`\n결과: 통과 ${pass} / 실패 ${fail}`);
  server.close();
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('검사 중 오류:', e); process.exit(2); });
