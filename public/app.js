// 화면. 사용자가 적은 글은 모두 textContent로만 넣어서 스크립트 모양 글자도 글자 그대로 보입니다.
(() => {
  'use strict';
  const app = document.getElementById('app');
  const PRIO = { 1: '높음', 2: '중간', 3: '낮음' };
  const SORT_LABEL = {
    due: '마감일 빠른 순', priority: '우선순위 높은 순', estimate: '예상 시간 짧은 순',
    created: '만든 순서', title: '이름 가나다 순',
  };

  // ---------- 도우미 ----------
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  let mutations = 0;
  async function api(path, opts = {}) {
    if (opts.method && opts.method !== 'GET') mutations++;
    const res = await fetch('/api/' + path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* 내용 없음 */ }
    if (!res.ok) throw new Error((data && data.error) || '요청에 실패했습니다.');
    return data;
  }
  let toastTimer;
  function toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg; t.className = 'show';
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = ''; }, 2600);
  }
  const fmtTime = (iso) => iso ? new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso)) : '';
  const fmtMin = (m) => `${m}분` + (m >= 60 ? ` (${(m / 60).toFixed(1)}시간)` : '');
  const fmtDiff = (m) => (m > 0 ? '+' : '') + m + '분';
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
  const field = (label, input) => h('label', {}, label, input);
  function prioSelect(name, val = 2) {
    return h('select', { name }, [1, 2, 3].map((n) => h('option', { value: n, selected: n === Number(val) }, PRIO[n])));
  }
  function formData(form) { return Object.fromEntries(new FormData(form).entries()); }
  function toLocalInput(iso) { // ISO → 서울 시간의 datetime-local 값
    const p = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso));
    return p.replace(' ', 'T');
  }
  async function guarded(btn, fn) {
    if (btn) btn.disabled = true;
    try { await fn(); } catch (e) { toast(e.message); } finally { if (btn) btn.disabled = false; }
  }

  // ---------- 길 찾기 ----------
  function parseHash() {
    const raw = location.hash.replace(/^#/, '') || 'cal';
    const [name, qs] = raw.split('?');
    const OLD = { plans: 'list', plan: 'list', tasks: 'list', review: 'see', do: 'list' }; // 예전 주소도 열리게
    const tab = ['cal', 'list', 'see'].includes(name) ? name : OLD[name] || 'cal';
    return { tab, q: Object.fromEntries(new URLSearchParams(qs || '')) };
  }
  function go(tab, q = {}) {
    const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== '' && v != null)).toString();
    location.hash = tab + (qs ? '?' + qs : '');
  }
  let calCache = null; // 달력이 방금 받은 자료 (같은 화면에서 팝업만 여닫을 때 다시 쓴다)
  let lastHash = null;
  let sameView = false; // 같은 주소를 다시 그리는 중이면 true (체크·저장 뒤 새로고침)
  async function render() {
    const { tab, q } = parseHash();
    // 같은 화면이면(주소가 같거나, 달력에서 창만 여닫거나 같은 달 안에서 날짜만 바뀐 경우) 비우지 않고 제자리를 지킵니다.
    // 달력은 주소에 날짜가 없으면 오늘로 보므로, 같은 기준으로 맞춰 비교합니다.
    let key = location.hash;
    if (tab === "cal") {
      const isD = (x) => /^\d{4}-\d{2}-\d{2}$/.test(x || "");
      const dd = isD(q.d) ? q.d : (/^\d{4}-\d{2}$/.test(q.m || "") ? q.m + "-01" : seoulToday());
      const vv = ["month", "week", "day"].includes(q.v) ? q.v : "month";
      key = "cal|" + vv + "|" + (vv === "day" ? dd : vv === "week" ? addDays(dd, -dowOf(dd)) : dd.slice(0, 7));
    }
    sameView = key === lastHash && app.childElementCount > 0;
    lastHash = key;
    const keepY = window.scrollY;
    const activeKey = tab === 'cal' && q.v === 'day' ? 'today' : tab;
    document.querySelectorAll('nav a[data-tab]').forEach((a) => a.classList.toggle('active', a.dataset.tab === activeKey));
    if (tab !== 'cal') { document.getElementById('side').replaceChildren(); closeDialogQuietly(); }
    if (!sameView) app.replaceChildren(h('p', { class: 'muted' }, '불러오는 중…'));
    try {
      const view = tab === 'list' ? await tasksView(q)
        : tab === 'see' ? await reviewView(q)
        : await calView(q);
      app.replaceChildren(view);
      if (sameView) window.scrollTo(0, keepY);
      else if (tab === 'cal' && q.d) { const p = document.getElementById('daypanel'); if (p) p.scrollIntoView({ block: 'nearest' }); }
    } catch (e) {
      app.replaceChildren(h('p', { class: 'error' }, '화면을 불러오지 못했습니다: ' + e.message),
        h('button', { onclick: render }, '다시 시도'));
    }
  }
  window.addEventListener('hashchange', render);
  // "오늘": 오늘 날짜의 '일' 보기를 열고 바로 적을 수 있게 날짜 창까지 엽니다
  document.getElementById('nav-today').addEventListener('click', (ev) => {
    ev.preventDefault();
    goOrRender('cal', { d: seoulToday(), v: 'day', p: '1' });
  });

  // ---------- 계획(할 일) ----------
  // 계획과 할 일은 같은 것입니다. 이 폼 하나로 만들고 고칩니다.
  function taskForm(task, onDone, defaults = {}) {
    const t = task || { title: '', start_date: '', due_date: '', priority: 2, tags: '', success_criteria: '', estimated_minutes: 0, ...defaults };
    const form = h('form', { class: 'grid' },
      h('label', { class: 'wide' }, '계획(할 일) 이름', h('input', { name: 'title', required: true, maxlength: 150, value: t.title })),
      field('시작일 (비우면 마감일과 같아요)', h('input', { type: 'date', name: 'start_date', value: t.start_date || '' })),
      field('마감일', h('input', { type: 'date', name: 'due_date', value: t.due_date || '' })),
      field('우선순위', prioSelect('priority', t.priority)),
      field('예상 시간(분)', h('input', { type: 'number', name: 'estimated_minutes', min: 0, step: 1, value: t.estimated_minutes })),
      field('태그 (쉼표로 구분)', h('input', { name: 'tags', maxlength: 200, value: t.tags })),
      h('label', { class: 'wide' }, '성공 기준 (무엇이 되면 잘한 걸까요? 비워도 돼요)',
        h('textarea', { name: 'success_criteria', maxlength: 500 }, t.success_criteria)),
      task ? h('label', { class: 'wide' }, '고친 이유 (이력에 남아요)', h('input', { name: 'change_note', maxlength: 300 })) : null,
      h('div', { class: 'row wide' },
        h('button', { class: 'primary', type: 'submit' }, task ? '고쳐서 저장' : '계획 추가'),
        task ? h('button', { type: 'button', onclick: () => onDone(false) }, '취소') : null));
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      guarded(form.querySelector('[type=submit]'), async () => {
        const body = formData(form);
        if (task) await api('tasks/' + task.id, { method: 'PUT', body });
        else await api('tasks', { method: 'POST', body });
        toast(task ? '고쳤어요. 처음 계획은 이력에 남아 있어요.' : '계획을 추가했어요.');
        onDone(true);
      });
    });
    return form;
  }

  function revisionTable(revisions) {
    return h('div', { class: 'tablewrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['버전', '바뀐 때', '이름', '기간', '우선순위', '예상 시간', '성공 기준', '메모'].map((x) => h('th', {}, x)))),
      h('tbody', {}, revisions.map((r) => h('tr', {},
        h('td', {}, r.version === 1 ? '1 (처음)' : r.version), h('td', {}, fmtTime(r.changed_at)), h('td', {}, r.title),
        h('td', {}, periodText(r)), h('td', {}, PRIO[r.priority]), h('td', {}, fmtMin(r.estimated_minutes)),
        h('td', {}, r.success_criteria || '—'), h('td', {}, r.change_note))))));
  }
  const periodText = (t) => (t.due_date ? (t.start_date && t.start_date !== t.due_date ? `${t.start_date} ~ ${t.due_date}` : t.due_date) : '날짜 없음');

  // 한 계획의 수정 이력 (맨 위가 처음 세운 계획)
  function historyPanel(task) {
    return h('div', { class: 'card' }, h('h3', {}, `수정 이력 (${task.revisions.length}개 버전)`), revisionTable(task.revisions));
  }

  function runForm(task, onDone, defDate) {
    const key = uid();
    const canMark = task.status !== 'done';
    const form = h('form', { class: 'grid' },
      field('시작 시각 (서울)', h('input', { type: 'datetime-local', name: 'started_at', required: true, value: defDate ? defDate + 'T09:00' : '' })),
      field('끝난 시각 (서울)', h('input', { type: 'datetime-local', name: 'ended_at', required: true, value: defDate ? defDate + 'T10:00' : '' })),
      field('실제로 걸린 시간(분) — 비우면 시작~끝으로 계산', h('input', { type: 'number', name: 'actual_minutes', min: 0, step: 1 })),
      field('막혔던 이유 (없으면 비워 두세요)', h('input', { name: 'blocked_reason', maxlength: 500 })),
      canMark ? h('label', { class: 'wide' }, '저장하면서 이 할 일을 완료로 표시', h('input', { type: 'checkbox', name: 'mark_done', value: '1', checked: true })) : null,
      h('div', { class: 'row wide' },
        h('button', { class: 'primary', type: 'submit' }, '기록 저장'),
        h('button', { type: 'button', onclick: () => onDone(false) }, '닫기')));
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      guarded(form.querySelector('[type=submit]'), async () => {
        const { mark_done: markDone, ...fields } = formData(form);
        const r = await api(`tasks/${task.id}/runs`, { method: 'POST', body: { ...fields, idempotency_key: key } });
        if (markDone) await api(`tasks/${task.id}/complete`, { method: 'POST', body: { idempotency_key: key + '-done' } });
        toast((r.created ? '실행 기록을 저장했어요. 원래 계획 값은 그대로예요.' : '이미 저장된 기록이에요.') + (markDone ? ' 완료로 표시했어요.' : ''));
        onDone(true);
      });
    });
    return form;
  }

  // 목록 탭: 모든 계획(할 일)을 검색·거르기·정렬로 찾아보고, 그 자리에서 완료·기록·고치기·지우기를 합니다.
  async function tasksView(q) {
    const mode = 'list';
    const today = await api('today');
    const sort = SORT_LABEL[q.sort] ? q.sort : 'due';
    const dir = q.dir === 'desc' ? 'desc' : 'asc';
    const params = new URLSearchParams();
    for (const k of ['q', 'status', 'priority', 'tag', 'late', 'blocked', 'from', 'to']) if (q[k]) params.set(k, q[k]);
    params.set('sort', sort); params.set('dir', dir);
    const tasks = await api('tasks?' + params);

    const box = h('div');
    box.append(h('h2', {}, '계획 목록'));
    box.append(h('p', { class: 'muted' }, '계획과 할 일은 같은 것이에요. 여기서 새로 적거나, 검색·거르기·정렬로 찾아볼 수 있어요. 돌아보기 숫자를 누르면 이 목록으로 도착해요.'));
    const addCard = h('details', { class: 'card' }, h('summary', {}, '+ 새 계획(할 일) 적기'), taskForm(null, () => render()));
    box.append(addCard);

    // 찾기·거르기·정렬
    const f = h('form', { class: 'grid card' },
      field('검색 (이름·태그)', h('input', { name: 'q', value: q.q || '' })),
      field('상태', h('select', { name: 'status' },
        [['', '전체'], ['doing', '진행 중'], ['done', '완료']].map(([v, l]) => h('option', { value: v, selected: v === (q.status || '') }, l)))),
      field('우선순위', h('select', { name: 'priority' }, h('option', { value: '' }, '전체'),
        [1, 2, 3].map((n) => h('option', { value: n, selected: String(n) === q.priority }, PRIO[n])))),
      field('태그', h('input', { name: 'tag', value: q.tag || '' })),
      field('정렬 기준', h('select', { name: 'sort' }, Object.entries(SORT_LABEL).map(([v, l]) => h('option', { value: v, selected: v === sort }, l)))),
      field('정렬 방향', h('select', { name: 'dir' }, [['asc', '위에서 아래로(기본)'], ['desc', '반대로']].map(([v, l]) => h('option', { value: v, selected: v === dir }, l)))),
      h('label', {}, '지연된 것만', h('input', { type: 'checkbox', name: 'late', value: '1', checked: q.late === '1' })),
      h('label', {}, '막힌 것만', h('input', { type: 'checkbox', name: 'blocked', value: '1', checked: q.blocked === '1' })),
      h('div', { class: 'row wide' }, h('button', { class: 'primary', type: 'submit' }, '적용'),
        h('button', { type: 'button', onclick: () => go(mode, {}) }, '조건 지우기')));
    f.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const fd = formData(f);
      go(mode, { ...fd, from: q.from, to: q.to });
    });
    box.append(f);

    const sortText = `정렬 기준: ${SORT_LABEL[sort]}${dir === 'desc' ? ' (반대 방향)' : ''} · 값이 같으면 할 일 번호(ID) 순 · 마감일이 없는 할 일은 맨 뒤`;
    box.append(h('p', { class: 'muted', id: 'sort-note' }, `${sortText} · 서울 기준 오늘: ${today.today}`));
    if (q.from || q.to) box.append(h('p', { class: 'muted' }, `마감일 범위: ${q.from || '처음'} ~ ${q.to || '끝'}`));

    const slot = h('div');
    box.append(slot);

    // 목록
    box.append(h('h3', {}, `목록 (${tasks.length}개)`));
    if (!tasks.length) box.append(h('p', { class: 'muted' }, '조건에 맞는 계획이 없어요.'));
    const tbody = h('tbody');
    for (const t of tasks) {
      const detail = h('tr', { hidden: true }, h('td', { colspan: 8 }));
      const row = h('tr', { class: t.status === 'done' ? 'done' : '' },
        h('td', {}, '#' + t.id),
        h('td', { class: 'title' }, t.title, ' ',
          t.late ? h('span', { class: 'late' }, '지연') : null, ' ',
          t.blocked ? h('span', { class: 'late' }, '막힘') : null,
          t.success_criteria ? h('div', { class: 'muted' }, '성공 기준: ' + t.success_criteria) : null,
          t.carried_lesson ? h('div', { class: 'ok' }, '지난 돌아보기에서 넘어온 고칠 점: ' + t.carried_lesson) : null),
        h('td', {}, periodText(t)),
        h('td', {}, PRIO[t.priority]),
        h('td', {}, t.tags ? t.tags.split(',').map((x) => h('span', { class: 'tag' }, x)) : '—'),
        h('td', {}, `예상 ${t.estimated_minutes}분 / 실제 ${t.actual_minutes}분`),
        h('td', {}, t.status === 'done' ? '완료' : '진행 중'),
        h('td', {}, h('div', { class: 'row' }, [
          t.status === 'done'
            ? h('button', { onclick: (e) => guarded(e.target, async () => { await api(`tasks/${t.id}/reopen`, { method: 'POST', body: {} }); toast('진행 중으로 되돌렸어요.'); render(); }) }, '되돌리기')
            : h('button', { onclick: (e) => guarded(e.target, async () => {
              const r = await api(`tasks/${t.id}/complete`, { method: 'POST', body: { idempotency_key: uid() } });
              toast(r.created ? '완료했어요.' : '이미 완료된 일이에요. 기록은 한 번만 남아요.'); render();
            }) }, '완료만 표시'),
          h('button', { class: 'primary', onclick: async () => {
            if (!detail.hidden && detail.dataset.mode === 'run') { detail.hidden = true; return; }
            const full = await api('tasks/' + t.id);
            detail.dataset.mode = 'run';
            detail.firstChild.replaceChildren(runPanel(full, () => render()));
            detail.hidden = false;
          } }, `실제로 한 일 기록 (${t.run_count})`),
          h('button', { onclick: async () => {
            if (!detail.hidden && detail.dataset.mode === 'hist') { detail.hidden = true; return; }
            const full = await api('tasks/' + t.id);
            detail.dataset.mode = 'hist';
            detail.firstChild.replaceChildren(historyPanel(full));
            detail.hidden = false;
          } }, '수정 이력'),
          h('button', { onclick: () => {
            slot.replaceChildren(h('div', { class: 'card' }, h('h3', {}, `#${t.id} 고치기`), taskForm(t, (ok) => ok ? render() : slot.replaceChildren())));
            slot.scrollIntoView({ block: 'center' });
          } }, '고치기'),
          h('button', { class: 'danger', onclick: (e) => {
            if (!confirm(`"${t.title}"을(를) 지울까요?`)) return;
            guarded(e.target, async () => { await api('tasks/' + t.id, { method: 'DELETE' }); toast('지웠어요.'); render(); });
          } }, '지우기'),
        ])));
      tbody.append(row, detail);
    }
    if (tasks.length) {
      box.append(h('div', { class: 'tablewrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['ID', '계획(할 일)', '기간', '우선순위', '태그', '시간', '상태', ''].map((x) => h('th', {}, x)))), tbody)));
    }
    return box;
  }

  function runPanel(task, onChange, defDate) {
    const wrap = h('div', { class: 'card' }, h('h3', {}, `#${task.id} ${task.title} — 실행 기록`));
    wrap.append(h('p', { class: 'muted' }, `원래 계획: 예상 ${task.estimated_minutes}분 · 기간 ${periodText(task)} (기록을 저장해도 바뀌지 않아요)`));
    if (!task.runs.length) wrap.append(h('p', { class: 'muted' }, '아직 기록이 없어요.'));
    else wrap.append(h('ul', { class: 'runs' }, task.runs.map((r) => h('li', {},
      `기록 #${r.id} · ${fmtTime(r.started_at)} ~ ${fmtTime(r.ended_at)} · ${r.actual_minutes}분`,
      r.blocked_reason ? h('span', { class: 'late' }, ' · 막힘: ' + r.blocked_reason) : null))));
    const slot = h('div');
    slot.replaceChildren(runForm(task, (ok) => ok ? onChange() : slot.replaceChildren(), defDate));
    wrap.append(h('h3', {}, '새 실행 기록 적기'), slot);
    return wrap;
  }

  // ---------- 다이어리 (달력 표) ----------
  const DOW = ['일', '월', '화', '수', '목', '금', '토'];
  const pad2 = (n) => String(n).padStart(2, '0');
  const parseDate = (s) => { const [y, m, d] = s.split('-').map(Number); return { y, m, d }; };
  const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
  const dowOf = (s) => new Date(s + 'T00:00:00Z').getUTCDay();
  const addDays = (s, n) => { const { y, m, d } = parseDate(s); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
  function addMonths(s, n) {
    const { y, m, d } = parseDate(s);
    const t = new Date(Date.UTC(y, m - 1 + n, 1));
    const yy = t.getUTCFullYear(), mm = t.getUTCMonth() + 1;
    return `${yy}-${pad2(mm)}-${pad2(Math.min(d, daysIn(yy, mm)))}`;
  }
  const seoulToday = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date());
  // 주소가 그대로면 화면을 다시 그려 주는 이동
  function goOrRender(tab, q) { const before = location.hash; go(tab, q); if (location.hash === before) render(); }

  const dlg = document.getElementById('dlg');
  // 창 닫기: 주소에서 p(창 열림)를 지우면 화면이 알아서 창을 닫습니다. (닫힘 알림에 기대지 않음)
  function closeDlg() {
    const { tab, q } = parseHash();
    if (tab === "cal" && q.p) go("cal", { d: q.d, v: q.v });
    else if (dlg.open) dlg.close();
  }
  // 적던 내용 지키기: 사용자가 글자를 입력한 칸에 내용이 남아 있으면 닫기 전에 물어봅니다.
  dlg.addEventListener('input', (ev) => { if (ev.isTrusted && ev.target.dataset) ev.target.dataset.touched = '1'; });
  function hasUnsaved() {
    return [...dlg.querySelectorAll('input[data-touched], textarea[data-touched]')]
      .some((el) => el.type !== 'checkbox' && String(el.value).trim() !== '');
  }
  // 사용자가 직접 닫으려 할 때(닫기 버튼·Esc·바깥 클릭)는 이 함수를 거칩니다.
  function requestClose() {
    if (hasUnsaved() && !confirm('적던 내용이 아직 저장되지 않았어요. 닫으면 사라져요. 그래도 닫을까요?')) return;
    closeDlg();
  }
  dlg.addEventListener("cancel", (ev) => { ev.preventDefault(); requestClose(); }); // Esc
  dlg.addEventListener("close", closeDlg); // 다른 방법으로 닫혔을 때도 주소를 맞춤
  // 바깥을 누르면 닫기: 누른 곳도 바깥이고 뗀 곳도 바깥일 때만. (창 안에서 드래그하다 바깥에서 놓은 경우는 무시)
  let downOnBackdrop = false;
  dlg.addEventListener('mousedown', (ev) => { downOnBackdrop = ev.target === dlg; });
  dlg.addEventListener('click', (ev) => { if (ev.target === dlg && downOnBackdrop) requestClose(); downOnBackdrop = false; });
  function closeDialogQuietly() { if (dlg.open) dlg.close(); }

  async function calView(q) {
    const fresh = (c) => c && sameView && Date.now() - c.at < 60000 && c.mut === mutations;
    const today = fresh(calCache) ? calCache.today : (await api('today')).today;
    const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
    let d = isDate(q.d) ? q.d : (/^\d{4}-\d{2}$/.test(q.m || '') ? (today.startsWith(q.m) ? today : q.m + '-01') : today);
    const v = ['month', 'week', 'day'].includes(q.v) ? q.v : 'month';
    const { y, m } = parseDate(d);
    const month = d.slice(0, 7);
    const mStart = `${month}-01`;
    const mEnd = `${month}-${pad2(daysIn(y, m))}`;
    let rs, re;
    if (v === 'month') { rs = mStart; re = mEnd; }
    else if (v === 'week') { rs = addDays(d, -dowOf(d)); re = addDays(rs, 6); }
    else { rs = d; re = d; }
    const from = rs < mStart ? rs : mStart;
    const to = re > mEnd ? re : mEnd;
    let tasks, recent;
    if (fresh(calCache) && calCache.range === from + '|' + to) {
      ({ tasks, recent } = calCache);
    } else {
      [tasks, recent] = await Promise.all([
        api(`tasks?from=${from}&to=${to}&sort=due`), api('tasks?sort=created&dir=desc')]);
      calCache = { range: from + '|' + to, tasks, recent, today, at: Date.now(), mut: mutations };
    }
    const byDate = {};
    for (const t of tasks) (byDate[t.due_date] = byDate[t.due_date] || []).push(t);

    // ----- 왼쪽: 작은 달력, 이번 달 달성률, 빠른 기록 -----
    const side = document.getElementById('side');
    const mini = h('div', { class: 'mini' });
    DOW.forEach((x) => mini.append(h('span', { class: 'mdow' }, x)));
    for (let i = 0; i < dowOf(mStart); i++) mini.append(h('span'));
    for (let day = 1; day <= daysIn(y, m); day++) {
      const date = `${month}-${pad2(day)}`;
      mini.append(h('button', {
        type: 'button', 'aria-label': date,
        class: 'md' + (date === d ? ' sel' : '') + (date === today ? ' today' : '') + (byDate[date] ? ' has' : ''),
        onclick: () => go('cal', { d: date, v }),
      }, day));
    }
    const miniCard = h('div', { class: 'card side-card' },
      h('div', { class: 'minihead' },
        h('button', { type: 'button', class: 'iconbtn', 'aria-label': '지난달', onclick: () => go('cal', { d: addMonths(d, -1), v }) }, '‹'),
        h('strong', {}, `${y}년 ${m}월`),
        h('button', { type: 'button', class: 'iconbtn', 'aria-label': '다음달', onclick: () => go('cal', { d: addMonths(d, 1), v }) }, '›')),
      mini);

    const monthTasks = tasks.filter((t) => t.due_date >= mStart && t.due_date <= mEnd);
    const doneN = monthTasks.filter((t) => t.status === 'done').length;
    const pct = monthTasks.length ? Math.round((doneN / monthTasks.length) * 100) : 0;
    const fill = h('div', { class: 'fill' });
    fill.style.width = pct + '%';
    const rateCard = h('div', { class: 'card side-card' },
      h('div', { class: 'ratehead' }, h('b', {}, '이번 달 달성률'), h('strong', {}, pct + '%')),
      h('div', { class: 'bar', role: 'img', 'aria-label': `이번 달 달성률 ${pct}%` }, fill),
      h('div', { class: 'muted' }, `완료 ${doneN}개 / 전체 ${monthTasks.length}개 (마감일이 이번 달인 할 일)`));

    // 빠른 기록: 최근에 적은 할 일을 선택한 날짜에 한 번에 다시 적기
    const seen = new Set(); const rec = [];
    for (const t of recent) { if (seen.has(t.title)) continue; seen.add(t.title); rec.push(t); if (rec.length === 4) break; }
    const quickAdd = async (body) => {
      await api('tasks', { method: 'POST', body: { start_date: d, due_date: d, ...body } });
      toast(`${d}에 적었어요.`); render();
    };
    const qform = h('form', { hidden: true },
      h('input', { name: 'title', maxlength: 150, placeholder: '계획(할 일) 이름', required: true, 'aria-label': '빠르게 적을 계획' }),
      h('button', { type: 'submit', class: 'primary' }, '적기'));
    qform.addEventListener('submit', (ev) => {
      ev.preventDefault();
      guarded(qform.querySelector('button'), () => quickAdd({ title: formData(qform).title }));
    });
    const quickCard = h('div', { class: 'card side-card quick' },
      h('div', { class: 'ratehead' }, h('b', {}, '빠른 기록'),
        h('button', { type: 'button', class: 'iconbtn', 'aria-label': '빠르게 적기 열기', onclick: () => { qform.hidden = !qform.hidden; if (!qform.hidden) qform.elements.title.focus(); } }, '+')),
      qform,
      rec.length
        ? h('ul', {}, rec.map((t) => h('li', {}, h('span', {}, t.title),
          h('button', { type: 'button', 'aria-label': `"${t.title}"을(를) ${d}에 적기`, onclick: (e) => guarded(e.target, () => quickAdd({ title: t.title, priority: t.priority, tags: t.tags, estimated_minutes: t.estimated_minutes })) }, '+'))))
        : h('p', { class: 'muted' }, '최근에 적은 할 일이 여기에 나와요. +를 누르면 선택한 날짜에 다시 적어요.'));
    side.replaceChildren(miniCard, rateCard, quickCard);

    // ----- 가운데: 월/주/일 표 -----
    const title = v === 'month' ? `${y}년 ${m}월`
      : v === 'week' ? `${rs.slice(5).replace('-', '/')} ~ ${re.slice(5).replace('-', '/')} (${y}년)`
        : `${d} (${DOW[dowOf(d)]})`;
    const step = (dir) => go('cal', { d: v === 'month' ? addMonths(d, dir) : addDays(d, dir * (v === 'week' ? 7 : 1)), v });
    const box = h('div');
    box.append(h('div', { class: 'diaryhead' },
      h('button', { type: 'button', class: 'iconbtn', 'aria-label': '이전', onclick: () => step(-1) }, '‹'),
      h('h2', {}, title),
      h('button', { type: 'button', class: 'iconbtn', 'aria-label': '다음', onclick: () => step(1) }, '›'),
      h('button', { type: 'button', onclick: () => go('cal', { d: today, v }) }, '오늘'),
      h('span', { class: 'spacer' }),
      h('div', { class: 'seg', role: 'group', 'aria-label': '보기 단위' },
        [['month', '월'], ['week', '주'], ['day', '일']].map(([val, label]) =>
          h('button', { type: 'button', 'aria-pressed': String(v === val), onclick: () => go('cal', { d, v: val }) }, label)))));

    const open = (date, extra = {}) => go('cal', { d: date, v, p: '1', ...extra });
    const tbody = h('tbody');
    for (let day = rs; day <= re; day = addDays(day, 1)) {
      const list = byDate[day] || [];
      const { m: dm, d: dd } = parseDate(day);
      const dateCell = (rowspan) => h('td', { class: 'date', rowspan, onclick: () => open(day) },
        `${dm}/${dd} (${DOW[dowOf(day)]})`, day === today ? h('span', { class: 'todaybadge' }, '오늘') : null);
      const sel = day === d ? ' sel' : '';
      if (!list.length) {
        tbody.append(h('tr', { class: 'empty' + sel, 'data-date': day },
          dateCell(1),
          h('td', { class: 'plan', onclick: () => open(day) }, '— 눌러서 적기'),
          h('td', { class: 'dodo' }, ''),
          h('td', { onclick: () => open(day) }, '-')));
        continue;
      }
      list.forEach((t, i) => {
        const doneNow = t.status === 'done';
        const box1 = h('input', { type: 'checkbox', checked: doneNow, 'aria-label': `${t.title} ${doneNow ? '달성 취소' : '달성'}` });
        box1.addEventListener('change', async () => {
          box1.disabled = true;
          try {
            if (box1.checked) await api(`tasks/${t.id}/complete`, { method: 'POST', body: { idempotency_key: uid() } });
            else await api(`tasks/${t.id}/reopen`, { method: 'POST', body: {} });
          } catch (e) { toast(e.message); } finally { render(); }
        });
        const note = t.run_count
          ? `실제 ${t.actual_minutes}분` + (t.last_blocked_reason ? ` · 막힘: ${t.last_blocked_reason}` : '')
          : '-';
        tbody.append(h('tr', { class: (doneNow ? 'done' : '') + sel, 'data-date': day },
          i === 0 ? dateCell(list.length) : null,
          h('td', { class: 'plan title', onclick: () => open(day) }, t.title, ' ',
            t.late ? h('span', { class: 'late' }, '지연') : null,
            t.start_date && t.start_date !== t.due_date ? h('span', { class: 'tag' }, `${t.start_date.slice(5)} 시작`) : null,
            t.tags ? t.tags.split(',').map((x) => h('span', { class: 'tag' }, x)) : null),
          h('td', { class: 'dodo' }, h('div', { class: 'seecell' },
            h('span', { onclick: () => open(day) }, note),
            h('button', { type: 'button', onclick: () => open(day, { open: t.id }) }, '기록'))),
          h('td', {}, h('label', { class: 'chk' }, box1, h('span', { class: doneNow ? 'yes' : '' }, doneNow ? '달성' : '미달성')))));
      });
    }
    box.append(h('div', { class: 'diary tablewrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['날짜', 'Plan (계획·할 일)', 'Do (기록 / 메모)', 'See (달성 여부)'].map((x) => h('th', {}, x)))),
      tbody)));
    box.append(h('p', { class: 'muted' }, '날짜나 할 일을 누르면 그날 창이 열려 할 일을 적고 실제로 한 일을 기록해요. Do 칸에는 실제로 한 일이 기록되고, See 칸의 체크로 달성 / 미달성을 봐요. 체크하면 바로 달성으로 바뀌고, 다시 풀면 미달성으로 돌아가요.'));

    // ----- 날짜 창 -----
    if (q.p === '1') {
      // 창 안을 다시 그려도 보던 자리를 지킵니다 (처음 열 때만 맨 위에서 시작)
      const wasOpen = dlg.open, innerTop = dlg.scrollTop, pageY = window.scrollY;
      dlg.replaceChildren(dayPanel(d, today, byDate[d] || [], v, Number(q.open) || null));
      if (!wasOpen) { dlg.showModal(); window.scrollTo(0, pageY); } else dlg.scrollTop = innerTop;
    } else {
      closeDialogQuietly();
    }
    if (!sameView) queueMicrotask(() => { const r = document.querySelector('tr.sel'); if (r && q.d) r.scrollIntoView({ block: 'nearest' }); });
    return box;
  }

  function dayPanel(date, today, list, v, openTaskId) {
    const refresh = () => goOrRender('cal', { d: date, v, p: '1' });
    const panel = h('div', { class: 'card', id: 'daypanel' },
      h('div', { class: 'dlghead' },
        h('h2', {}, `${date} (${DOW[dowOf(date)]})${date === today ? ' · 오늘' : ''}`),
        h('button', { type: 'button', onclick: requestClose }, '닫기')));

    const est = list.reduce((s, t) => s + t.estimated_minutes, 0);
    const act = list.reduce((s, t) => s + t.actual_minutes, 0);
    const done = list.filter((t) => t.status === 'done').length;
    panel.append(h('p', {}, `이 날 계획 ${list.length}개 · 달성 ${done}개 · 예상 ${est}분 / 실제 ${act}분`));
    if (!list.length) panel.append(h('p', { class: 'muted' }, '아직 적은 계획이 없어요. 아래에서 적어 보세요.'));

    for (const t of list) {
      const slot = h('div');
      const showRun = async () => {
        const full = await api('tasks/' + t.id);
        slot.dataset.open = 'run';
        slot.replaceChildren(runPanel(full, refresh, date));
      };
      panel.append(h('div', { class: 'taskrow' + (t.status === 'done' ? ' done' : '') },
        h('div', { class: 'row' },
          h('strong', { class: 'title' }, t.title),
          t.late ? h('span', { class: 'late' }, '지연') : null,
          t.blocked ? h('span', { class: 'late' }, '막힘') : null,
          t.tags ? t.tags.split(',').map((x) => h('span', { class: 'tag' }, x)) : null),
        h('div', { class: 'muted' }, `기간 ${periodText(t)} · 우선순위 ${PRIO[t.priority]} · 예상 ${t.estimated_minutes}분 / 실제 ${t.actual_minutes}분 · ${t.status === 'done' ? '달성' : '미달성'}`),
        t.success_criteria ? h('div', { class: 'muted' }, '성공 기준: ' + t.success_criteria) : null,
        t.carried_lesson ? h('div', { class: 'ok' }, '지난 돌아보기에서 넘어온 고칠 점: ' + t.carried_lesson) : null,
        h('div', { class: 'row' },
          t.status === 'done'
            ? h('button', { onclick: (e) => guarded(e.target, async () => { await api(`tasks/${t.id}/reopen`, { method: 'POST', body: {} }); toast('미달성으로 되돌렸어요.'); refresh(); }) }, '되돌리기')
            : h('button', { onclick: (e) => guarded(e.target, async () => {
              const r = await api(`tasks/${t.id}/complete`, { method: 'POST', body: { idempotency_key: uid() } });
              toast(r.created ? '달성으로 표시했어요.' : '이미 달성한 일이에요. 기록은 한 번만 남아요.'); refresh();
            }) }, '달성'),
          h('button', { class: 'primary', onclick: async () => {
            if (slot.dataset.open === 'run') { slot.dataset.open = ''; slot.replaceChildren(); return; }
            await showRun();
          } }, `실제로 한 일 기록 (${t.run_count})`),
          h('button', { onclick: () => {
            slot.dataset.open = 'edit';
            slot.replaceChildren(h('div', { class: 'card' }, h('h3', {}, '고치기'), taskForm(t, (ok) => ok ? refresh() : slot.replaceChildren())));
          } }, '고치기'),
          h('button', { onclick: async () => {
            if (slot.dataset.open === 'hist') { slot.dataset.open = ''; slot.replaceChildren(); return; }
            const full = await api('tasks/' + t.id);
            slot.dataset.open = 'hist';
            slot.replaceChildren(historyPanel(full));
          } }, '수정 이력'),
          h('button', { class: 'danger', onclick: (e) => {
            if (!confirm(`"${t.title}"을(를) 지울까요?`)) return;
            guarded(e.target, async () => { await api('tasks/' + t.id, { method: 'DELETE' }); toast('지웠어요.'); refresh(); });
          } }, '지우기')),
        slot));
      if (openTaskId === t.id) {
        showRun().then(() => slot.scrollIntoView({ block: "nearest" })).catch((e) => toast(e.message));
      }
    }

    // 이 날 계획 적기: 계획과 할 일은 같은 것이라 폼이 하나입니다
    panel.append(h('div', { class: 'card' }, h('h3', {}, '이 날 계획(할 일) 적기'),
      taskForm(null, refresh, { start_date: date, due_date: date })));
    return panel;
  }

  // ---------- 돌아보기 ----------
  async function reviewView(q) {
    const past = await api('reviews');
    const p = new URLSearchParams();
    for (const k of ['from', 'to']) if (q[k]) p.set(k, q[k]);
    const r = await api('review?' + p);
    const box = h('div');
    box.append(h('h2', {}, '돌아보기'));

    const f = h('form', { class: 'grid card' },
      field('마감일 시작 (비우면 처음부터)', h('input', { type: 'date', name: 'from', value: q.from || '' })),
      field('마감일 끝 (비우면 끝까지)', h('input', { type: 'date', name: 'to', value: q.to || '' })),
      h('div', { class: 'row wide' }, h('button', { class: 'primary', type: 'submit' }, '보기')));
    f.addEventListener('submit', (ev) => { ev.preventDefault(); go('see', formData(f)); });
    box.append(f);

    const base = { from: q.from, to: q.to };
    const link = (label, n, extra) => h('a', { class: 'stat', href: '#list?' + new URLSearchParams(Object.entries({ ...base, ...extra }).filter(([, v]) => v)).toString() },
      h('b', {}, n), h('span', {}, label + ' — 눌러서 기록 보기'));
    box.append(h('div', { class: 'stats' },
      link('계획 수 (지우지 않은 계획·할 일)', r.planned, {}),
      link('달성(완료) 수', r.done, { status: 'done' }),
      link('지연 수', r.late, { late: '1' }),
      link('막힘 수', r.blocked, { blocked: '1' })));

    box.append(h('div', { class: 'stats gap' },
      link('예상 시간 합계', fmtMin(r.estimated_minutes), {}),
      link('실제 시간 합계', fmtMin(r.actual_minutes), { status: '' }),
      h('div', { class: 'stat' }, h('b', { class: r.diff_minutes > 0 ? 'late' : 'ok' }, fmtDiff(r.diff_minutes)),
        h('span', {}, '차이 = 실제 − 예상 (+면 계획보다 오래 걸림)'))));
    box.append(h('p', { class: 'muted' }, '지연 = 아직 달성하지 못했고 마감일이 서울 기준 오늘보다 앞선 계획. 막힘 = 막힌 이유가 한 번이라도 적힌 계획.'));

    // 다음 계획으로
    const lesson = h('form', { class: 'grid card' },
      h('h3', { class: 'wide' }, '고칠 점 한 가지를 다음 계획으로 넘기기'),
      field('고칠 점 (한 줄)', h('input', { name: 'lesson', required: true, maxlength: 300, class: 'wide' })),
      field('다음 계획 시작일', h('input', { type: 'date', name: 'next_start_date', required: true })),
      field('다음 계획 마감일', h('input', { type: 'date', name: 'next_due_date', required: true })),
      field('예상 시간(분)', h('input', { type: 'number', name: 'next_estimated_minutes', min: 0, value: 0 })),
      field('다음 계획 이름 (비우면 자동)', h('input', { name: 'next_title', maxlength: 150 })),
      h('div', { class: 'row wide' }, h('button', { class: 'primary', type: 'submit' }, '다음 계획으로 넘기기')));
    lesson.addEventListener('submit', (ev) => {
      ev.preventDefault();
      guarded(lesson.querySelector('[type=submit]'), async () => {
        const res = await api('review/carry', { method: 'POST', body: { ...formData(lesson), ...base } });
        toast('다음 계획으로 넘겼어요.'); go('list');
        void res;
      });
    });
    box.append(lesson);

    box.append(h('h3', {}, `지난 돌아보기 (${past.length})`));
    if (!past.length) box.append(h('p', { class: 'muted' }, '아직 없어요.'));
    for (const x of past) {
      box.append(h('div', { class: 'card' },
        h('p', {}, `#${x.id} · ${fmtTime(x.created_at)} · 고칠 점: ${x.lesson}`),
        h('p', { class: 'muted' }, `그때 숫자: 계획 ${x.snapshot.planned} · 완료 ${x.snapshot.done} · 지연 ${x.snapshot.late} · 막힘 ${x.snapshot.blocked} · 예상 ${x.snapshot.estimated_minutes}분 · 실제 ${x.snapshot.actual_minutes}분`),
        x.next_task_id ? h('p', {}, h('a', { href: '#list' }, `→ 다음 계획 #${x.next_task_id} 으로 넘어감`)) : null));
    }
    return box;
  }

  render();
})();
