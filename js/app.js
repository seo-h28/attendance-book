import { KEYPAD, matchName } from './hangul.js';
import * as store from './store.js';
import { state, WEEKDAYS, dateKey, dateLabel } from './store.js';
import { readFile, parseRoster, findBackup } from './roster.js';
import { buildBook, rosterTemplate, rosterSheet, download, classDates, sessions } from './book.js';
import { makeDemoData, DEMO_PIN } from './demo.js';
import { holidayName, HOLIDAYS, HOLIDAYS_UNTIL } from './holidays.js';

// 코드를 고쳐 배포할 때마다 올린다 (sw.js 의 VERSION 과 같이)
const APP_VERSION = '1.2.0';

/* ---------- 작은 도우미 ---------- */

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}

let toastTimer;
function toast(text, { undo, info } = {}) {
  const t = document.getElementById('toast');
  t.replaceChildren(h('span', {}, text), undo && h('button', { onclick: () => { undo(); hideToast(); } }, '취소'));
  t.className = 'show' + (info ? ' info' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, undo ? 4000 : 2500);
}
function hideToast() {
  document.getElementById('toast').className = '';
}

/** 큰 버튼 대화상자. 누른 버튼의 value를 돌려준다. */
// 버튼 value 함수가 이 값을 돌려주면 창을 닫지 않는다 (입력 확인용)
const KEEP_OPEN = Symbol('keep');

function modal(title, body, buttons = [{ label: '확인', value: true, primary: true }], { wide = false } = {}) {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    const close = (v) => { overlay.remove(); resolve(v); };
    const overlay = h('div', { class: 'overlay', onclick: (e) => e.target === overlay && close(null) },
      h('div', { class: 'modal' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true' },
        title && h('h2', {}, title),
        typeof body === 'string' ? h('div', { class: 'msg' }, body) : body,
        h('div', { class: 'actions' },
          buttons.map((b) => h('button', {
            class: 'btn' + (b.primary ? ' primary' : '') + (b.danger ? ' danger' : ''),
            onclick: () => {
              const v = typeof b.value === 'function' ? b.value() : b.value;
              if (v !== KEEP_OPEN) close(v);
            },
          }, b.label)))));
    root.append(overlay);
  });
}
const confirmBox = (title, msg, yes = '예', danger = false) =>
  modal(title, msg, [{ label: '아니요', value: false }, { label: yes, value: true, primary: !danger, danger }]);

/** 숫자 4자리 PIN 입력 */
function askPin(title, hint = '') {
  return new Promise((resolve) => {
    let pin = '';
    const dots = h('div', { class: 'pin-dots' });
    const err = h('div', { class: 'pin-err' }, hint);
    const draw = () => dots.replaceChildren(...[0, 1, 2, 3].map((i) => h('span', { class: i < pin.length ? 'on' : '' })));
    const done = (v) => { overlay.remove(); resolve(v); };
    const press = (k) => {
      if (k === '⌫') pin = pin.slice(0, -1);
      else if (pin.length < 4) pin += k;
      draw();
      if (pin.length === 4) setTimeout(() => done(pin), 120);
    };
    draw();
    const overlay = h('div', { class: 'overlay' },
      h('div', { class: 'modal', style: 'width:min(400px,100%)' },
        h('h2', { style: 'text-align:center' }, title), dots, err,
        h('div', { class: 'pinpad' },
          ['1', '2', '3', '4', '5', '6', '7', '8', '9', '닫기', '0', '⌫'].map((k) =>
            h('button', { onclick: () => (k === '닫기' ? done(null) : press(k)) }, k)))));
    document.getElementById('modal-root').append(overlay);
  });
}

function pickFile(accept = '.xlsx,.csv') {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, style: 'display:none' });
    input.addEventListener('change', () => { resolve(input.files[0] || null); input.remove(); });
    document.body.append(input);
    input.click();
  });
}

const fmtTime = (ms) => {
  if (!ms) return '없음';
  const d = new Date(ms);
  return `${d.getMonth() + 1}월 ${d.getDate()}일 ${store.timeStr(d)}`;
};
const paletteVars = (c) => `--pc:${c.c};--pc-ink:${c.ink}`;
const colorVars = (program) => paletteVars(store.colorOf(program));
const offShort = (reason) => (reason === '휴강' ? '휴강' : '공휴일');
const offLong = (reason) => (reason === '휴강' ? '휴강' : `휴강 · ${reason}`);
const daysText = (days = []) => store.sortDays(days).map((d) => WEEKDAYS[d]).join('·');

/** 무지개 색 고르기 동그라미. onPick(i) */
function swatches(selected, onPick) {
  const wrap = h('div', { class: 'chips', role: 'radiogroup', 'aria-label': '수업 색깔' });
  const draw = (sel) => wrap.replaceChildren(...store.PALETTE.map((c, i) => h('button', {
    type: 'button', class: 'swatch', style: `--sw:${c.c};--sw-ink:${c.ink}`, title: c.name, 'aria-label': `${c.name}색`,
    role: 'radio', 'aria-checked': String(sel === i),
    onclick: () => { draw(i); onPick(i); },
  })));
  draw(selected);
  return wrap;
}

/**
 * 요일 고르기 + 요일별 시간. 바뀔 때마다 onChange({days, times})
 * 새 요일을 고르면 앞서 정한 시간을 그대로 채워 준다.
 */
function scheduleEditor(init, onChange) {
  let days = [...(init.days || [])];
  const times = {};
  for (const d of days) times[d] = store.timeOn(init, d);
  const order = [1, 2, 3, 4, 5, 6, 0];
  const chips = h('div', { class: 'chips' });
  const rows = h('div', { class: 'time-rows' });
  const emit = () => onChange({ days: store.sortDays(days), times: Object.fromEntries(days.map((d) => [d, times[d] || ''])) });
  const timeInputs = (d) => {
    const [s = '', e = ''] = (times[d] || '').split('-');
    const start = h('input', { type: 'time', class: 'input', value: s, 'aria-label': `${WEEKDAYS[d]}요일 시작 시간` });
    const end = h('input', { type: 'time', class: 'input', value: e, 'aria-label': `${WEEKDAYS[d]}요일 끝 시간` });
    const update = () => { times[d] = start.value || end.value ? `${start.value}-${end.value}` : ''; emit(); };
    start.addEventListener('change', update);
    end.addEventListener('change', update);
    return h('div', { class: 'time-row' }, h('b', {}, `${WEEKDAYS[d]}요일`), start, h('span', {}, '~'), end);
  };
  const draw = () => {
    chips.replaceChildren(...order.map((d) => h('button', {
      type: 'button', class: 'chip', 'aria-pressed': String(days.includes(d)),
      onclick: () => {
        if (days.includes(d)) days = days.filter((x) => x !== d);
        else {
          days.push(d);
          times[d] ||= Object.values(times).find(Boolean) || '';
        }
        draw();
        emit();
      },
    }, WEEKDAYS[d])));
    rows.replaceChildren(...store.sortDays(days).map(timeInputs));
    if (!days.length) rows.append(h('p', { class: 'help', style: 'margin:0' }, '수업 요일을 고르면 요일마다 시간을 정할 수 있습니다.'));
  };
  draw();
  return h('div', { class: 'schedule' }, chips, rows);
}

/* ---------- 화면 상태 ---------- */

const ui = {
  view: 'check', // check | pick | calendar | admin
  calMonth: dateKey().slice(0, 7),
  calDay: null,
  program: null,
  query: '',
  mode: 'cho', // cho | num
  tab: 'roster',
  unlocked: false,
  gridProgram: null,
  gridMonth: dateKey().slice(0, 7),
  bookProgram: '',
  bookMonth: dateKey().slice(0, 7),
  bookMonths: 1,
};

const app = document.getElementById('app');
const mount = (...nodes) => app.replaceChildren(...[demoBanner(), nodes].flat(Infinity).filter((n) => n && n.nodeType));

/* ---------- 체험 모드 (?demo) ---------- */

function demoBanner() {
  if (!store.isDemo) return null;
  return h('div', { class: 'demo-banner' },
    h('span', {}, h('b', {}, '체험 모드'), ' · 가상 데이터입니다 · 관리 비밀번호 ', h('b', {}, DEMO_PIN)),
    h('button', { class: 'btn small', onclick: async () => {
      if (!(await confirmBox('가상 데이터 새로 만들기', '지금까지 체험하며 바꾼 내용을 지우고 가상 데이터를 새로 만들까요?', '새로 만들기'))) return;
      store.replaceState(makeDemoData());
      Object.assign(ui, { view: 'check', program: null, query: '', unlocked: false });
      render();
    } }, '가상 데이터 새로 만들기'),
    h('button', { class: 'btn small', onclick: () => { location.href = location.pathname; } }, '체험 끝내기'));
}

let lastScreen = '';
function render() {
  const today = dateKey();
  app.classList.remove('fit');
  app.style.cssText = '';
  // 같은 화면을 다시 그릴 때(요일 선택 등)는 스크롤 위치를 그대로 둔다
  const screen = `${ui.view}|${ui.tab}`;
  if (screen !== lastScreen) window.scrollTo(0, 0);
  lastScreen = screen;
  if (ui.view === 'admin') return renderAdmin();
  if (!store.programNames().length) return renderWelcome();
  if (ui.view === 'calendar') return renderCalendar(today);
  if (!ui.program || !state.programs[ui.program] || state.programs[ui.program].deleted || ui.view === 'pick') return renderPicker(today);
  renderCheck(today);
}

/* ---------- 처음 화면 ---------- */

function renderWelcome() {
  mount(
    h('div', { class: 'picker' },
      h('h1', {}, '출석부'),
      h('p', { class: 'help', style: 'font-size:19px' },
        '아직 명단이 없습니다.', h('br'),
        '담당자께서 [관리] → [명단 불러오기]에서 프로그램 신청 명단 엑셀 파일을 불러와 주세요.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: openAdmin }, '관리 화면 열기'),
        !store.isDemo && h('button', { class: 'btn', onclick: () => { location.href = location.pathname + '?demo'; } }, '가상 데이터로 체험해 보기')),
      !store.isDemo && h('p', { class: 'help' }, '체험 모드는 실제 데이터와 따로 저장되므로 마음껏 눌러 보셔도 됩니다.')));
}

/* ---------- 프로그램 고르기 ---------- */

function renderPicker(today) {
  const wd = new Date().getDay();
  const names = store.programNames();
  // 오늘 수업은 시작 시간 순서로
  const todays = names.filter((n) => state.programs[n].days?.includes(wd))
    .sort((a, b) => store.timeOn(state.programs[a], wd).localeCompare(store.timeOn(state.programs[b], wd)));
  const others = names.filter((n) => !todays.includes(n));
  const summary = Object.fromEntries(store.daySummary(today).map((s) => [s.name, s]));
  const item = (n, isToday) => {
    const p = state.programs[n];
    const count = store.membersOf(n).length;
    const s = summary[n];
    return h('button', { class: 'item' + (isToday ? ' today' : ''), style: colorVars(n), onclick: () => { ui.program = n; ui.view = 'check'; ui.query = ''; render(); } },
      h('b', {}, n),
      h('span', {}, [isToday ? store.timeOn(p, wd) : store.scheduleText(p), `${count}명`].filter(Boolean).join('  ·  ')),
      isToday && s && h('em', { class: 'item-status' + (s.off ? ' off' : '') }, s.off ? `오늘 ${offLong(s.reason)}` : `오늘 ${s.present} / ${s.total}명 출석`));
  };
  mount(
    h('header', { class: 'top' },
      h('div', { class: 'date', style: 'font-size:20px;color:var(--ink);font-weight:700' }, dateLabel(today)),
      h('div', { class: 'spacer' }),
      h('button', { class: 'btn gear', onclick: openCalendar }, '달력'),
      h('button', { class: 'btn gear', onclick: openAdmin }, '관리')),
    h('div', { class: 'picker' },
      h('h1', {}, '어떤 수업의 출석을 받을까요?'),
      todays.length ? [h('h2', {}, '오늘 수업'), h('div', { class: 'list' }, todays.map((n) => item(n, true)))] : null,
      others.length ? [h('h2', {}, todays.length ? '다른 수업' : '수업 목록'), h('div', { class: 'list' }, others.map((n) => item(n, false)))] : null));
}

/* ---------- 달력 ---------- */
// 이름 없이 수업별 인원수만 보여 주므로 비밀번호 없이 열 수 있다.

function openCalendar() {
  ui.calMonth = dateKey().slice(0, 7);
  ui.calDay = dateKey();
  ui.view = 'calendar';
  render();
}

function shiftMonth(delta) {
  const [y, m] = ui.calMonth.split('-').map(Number);
  ui.calMonth = dateKey(new Date(y, m - 1 + delta, 1)).slice(0, 7);
  ui.calDay = null;
  render();
}

/** '11월 수업 8회 중 3번째' */
function sessionLabel(program, date) {
  const { held } = sessions(program, date.slice(0, 7), 1);
  const i = held.indexOf(date);
  return i >= 0 ? `${Number(date.slice(5, 7))}월 수업 ${held.length}회 중 ${i + 1}번째` : '';
}

function renderCalendar(today) {
  const [y, m] = ui.calMonth.split('-').map(Number);
  const startPad = new Date(y, m - 1, 1).getDay();
  const lastDay = new Date(y, m, 0).getDate();
  if (!ui.calDay?.startsWith(ui.calMonth)) ui.calDay = today.startsWith(ui.calMonth) ? today : `${ui.calMonth}-01`;
  const sel = ui.calDay;

  const cells = WEEKDAYS.map((w, i) => h('div', { class: 'cal-wd' + (i === 0 ? ' sun' : i === 6 ? ' sat' : '') }, w));
  for (let i = 0; i < startPad; i++) cells.push(h('div', { class: 'cal-cell blank' }));
  for (let d = 1; d <= lastDay; d++) {
    const key = `${ui.calMonth}-${String(d).padStart(2, '0')}`;
    const wd = (startPad + d - 1) % 7;
    const done = key <= today;
    const hol = holidayName(key);
    cells.push(h('button', {
      class: 'cal-cell' + (key === today ? ' today' : '') + (key === sel ? ' sel' : '') + (wd === 0 || hol ? ' sun' : wd === 6 ? ' sat' : ''),
      'aria-label': dateLabel(key),
      onclick: () => { ui.calDay = key; render(); },
    },
      h('span', { class: 'cal-d' }, d, hol && h('span', { class: 'cal-hol' }, hol)),
      store.daySummary(key).map((s) => h('span', { class: 'cal-pill' + (s.off ? ' off' : ''), style: colorVars(s.name) },
        h('span', { class: 'nm' }, s.name),
        h('span', { class: 'st' }, s.off ? offShort(s.reason) : done ? `${s.present}/${s.total}` : '')))));
  }

  const list = store.daySummary(sel);
  const past = sel <= today;
  const held = list.filter((s) => !s.off);
  const detail = h('section', { class: 'cal-detail' },
    h('h2', {}, dateLabel(sel), sel === today && h('span', { class: 'today-badge' }, '오늘')),
    holidayName(sel) && h('p', { class: 'hol-note' }, `${holidayName(sel)} (공휴일)`),
    past && held.length > 0 && h('p', { class: 'help' }, `수업 ${held.length}개 · 모두 ${held.reduce((a, s) => a + s.present, 0)}명 출석`),
    list.length
      ? list.map((s) => {
        const p = state.programs[s.name];
        const rate = s.total ? Math.round((s.present / s.total) * 100) : 0;
        return h('div', { class: 'cal-item' + (s.off ? ' off' : ''), style: colorVars(s.name) },
          h('div', { class: 'ci-head' },
            h('b', {}, s.name),
            h('span', {}, [store.timeOn(p, store.parseDate(sel).getDay()), p.teacher && `${p.teacher} 강사`].filter(Boolean).join(' · '))),
          s.off ? h('div', { class: 'ci-status' }, offLong(s.reason))
            : past ? [
              h('div', { class: 'ci-status' }, h('strong', {}, s.present), ` / ${s.total}명 출석`, h('small', {}, ` (${rate}%)`)),
              h('div', { class: 'bar', role: 'img', 'aria-label': `출석률 ${rate}%` }, h('span', { style: `width:${rate}%` })),
            ]
            : h('div', { class: 'ci-status muted' }, `수업 예정 · ${s.total}명`),
          !s.off && h('div', { class: 'ci-count' }, sessionLabel(s.name, sel)),
          sel === today && !s.off && h('button', { class: 'btn small', onclick: () => { ui.program = s.name; ui.view = 'check'; ui.query = ''; render(); } }, '출석 받기'));
      })
      : h('p', { class: 'help' }, '이날은 수업이 없습니다.'));

  mount(
    h('header', { class: 'top' },
      h('button', { class: 'btn gear', onclick: () => { ui.view = ui.program ? 'check' : 'pick'; render(); } }, '← 돌아가기'),
      h('div', { class: 'cal-nav' },
        h('button', { class: 'btn small', 'aria-label': '이전 달', onclick: () => shiftMonth(-1) }, '‹'),
        h('b', {}, `${y}년 ${m}월`),
        h('button', { class: 'btn small', 'aria-label': '다음 달', onclick: () => shiftMonth(1) }, '›')),
      h('div', { class: 'spacer' }),
      h('button', { class: 'btn gear', onclick: openCalendar }, '오늘로')),
    h('main', { class: 'calendar' },
      h('div', { class: 'cal-grid' }, cells),
      detail));
}

/* ---------- 출석 체크 ---------- */

let resultsEl;
let queryEl;
let countEl;

function renderCheck(today) {
  const p = state.programs[ui.program];
  const members = store.membersOf(ui.program);
  const offWhy = store.offReason(ui.program, today);
  const isOff = !!offWhy;
  const notToday = !!p.days?.length && !p.days.includes(new Date().getDay());

  countEl = h('div', { class: 'count' });
  queryEl = h('div', { class: 'querybar' });
  resultsEl = h('div', { class: 'grid' });
  app.classList.add('fit');
  app.style.cssText = colorVars(ui.program);

  mount(
    h('header', { class: 'top' },
      h('button', { class: 'prog-btn', onclick: () => { ui.view = 'pick'; render(); } }, ui.program, h('small', {}, '바꾸기 ▾')),
      h('div', { class: 'date' }, dateLabel(today)),
      h('div', { class: 'spacer' }),
      countEl,
      state.device && h('div', { class: 'device' }, state.device),
      h('button', { class: 'btn gear', onclick: openCalendar }, '달력'),
      h('button', { class: 'btn gear', onclick: openAdmin }, '관리')),
    isOff && h('div', { class: 'banner' }, offWhy === '휴강'
      ? '오늘은 휴강일로 등록되어 있습니다.'
      : `오늘은 ${offWhy}(공휴일)이라 휴강으로 표시됩니다. 수업을 했다면 그대로 출석을 받으면 됩니다.`),
    !isOff && notToday && h('div', { class: 'banner' }, `이 수업은 ${daysText(p.days)}요일 수업입니다. 오늘 출석이 맞는지 확인해 주세요.`),
    h('main', { class: 'check' },
      h('section', { class: 'results' },
        queryEl,
        resultsEl,
        h('button', { class: 'btn add-extra', onclick: addExtra }, '+ 명단에 없는 분 출석')),
      renderPad()));
  updateResults(today, members);
  guardTaps();
  keepScreenOn();
}

function renderPad() {
  const modeBtn = (mode, label) =>
    h('button', { 'aria-pressed': String(ui.mode === mode), onclick: () => { ui.mode = mode; ui.query = ''; render(); } }, label);
  const type = (k) => { ui.query += k; updateResults(); };
  const keys = ui.mode === 'cho'
    ? KEYPAD.map((k) => h('button', { class: 'key', onclick: () => type(k) }, k))
    : ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'].map((k) => h('button', { class: 'key', onclick: () => ui.query.length < 4 && type(k) }, k));
  return h('aside', { class: 'pad' },
    h('div', { class: 'modes' }, modeBtn('cho', '이름 초성'), modeBtn('num', '전화 뒷자리')),
    h('div', { class: 'keys' + (ui.mode === 'num' ? ' num' : '') },
      keys,
      h('button', { class: 'key fn', onclick: () => { ui.query = [...ui.query].slice(0, -1).join(''); updateResults(); } }, '⌫ 한 칸'),
      h('button', { class: 'key fn', onclick: () => { ui.query = ''; updateResults(); } }, '처음부터')));
}

function updateResults(today = dateKey(), members = store.membersOf(ui.program)) {
  const dup = store.duplicateNames(members);
  const q = ui.query;
  const hits = !q ? members
    : ui.mode === 'cho' ? members.filter((m) => matchName(m.name, q))
    : members.filter((m) => m.last4.startsWith(q));
  const present = store.countPresent(today, members);

  countEl.replaceChildren(h('b', {}, present), ` / ${members.length}명 출석`);
  queryEl.replaceChildren(
    q ? h('div', { class: 'q' }, q) : h('div', { class: 'q placeholder' }, ui.mode === 'cho' ? '이름 첫 글자들의 초성을 누르세요 (예: 김미자 → ㄱㅁㅈ)' : '전화번호 뒤 4자리를 누르세요'),
    q && h('div', { class: 'hits' }, `${hits.length}명`),
    q && h('button', { class: 'btn small', onclick: () => { ui.query = ''; updateResults(); } }, '✕'));

  if (!members.length) {
    resultsEl.replaceChildren(h('div', { class: 'empty', style: 'grid-column:1/-1' }, '이 수업의 명단이 비어 있습니다.'));
    return;
  }
  if (!hits.length) {
    resultsEl.replaceChildren(h('div', { class: 'empty', style: 'grid-column:1/-1' }, '찾는 분이 없습니다.', h('br'), '초성을 다시 확인하거나 [명단에 없는 분 출석]을 눌러 주세요.'));
    return;
  }
  resultsEl.replaceChildren(...hits.map((m) => {
    const rec = store.getRecord(today, m.id);
    const showTail = (dup.has(m.name) || ui.mode === 'num') && m.last4;
    const label = dup.has(m.name) && m.last4 ? `${m.name}(${m.last4})` : m.name;
    return h('button', { class: 'card' + (rec ? ' done' : ''), onclick: () => tapMember(m, label, today) },
      h('div', { class: 'nm' }, m.name),
      h('div', { class: 'sub' },
        showTail && h('span', { class: 'tail' }, `뒷자리 ${m.last4}`),
        showTail && rec && ' ',
        rec ? `${rec.t} 출석` : ''));
  }));
  resultsEl.scrollTop = 0;
}

// 화면이 바뀐 직후의 터치는 무시한다. 두 번 빠르게 누르면
// 바뀐 화면에서 같은 자리에 있던 다른 분이 출석되는 사고를 막는다.
let tapGuardUntil = 0;
const guardTaps = () => (tapGuardUntil = Date.now() + 700);

async function tapMember(m, label, today) {
  if (Date.now() < tapGuardUntil) return;
  if (store.getRecord(today, m.id)) {
    const ok = await confirmBox('출석 취소', `${label} 님의 오늘 출석을 취소할까요?`, '출석 취소', true);
    if (!ok) return;
    store.setAttendance(today, m.id, false);
    toast(`${label} 님 출석 취소됨`, { info: true });
  } else {
    store.setAttendance(today, m.id, true);
    toast(`${label} 님 출석!`, { undo: () => { store.setAttendance(today, m.id, false); updateResults(); } });
  }
  ui.query = '';
  updateResults();
  guardTaps();
}

async function addExtra() {
  const name = h('input', { class: 'input', placeholder: '이름', autocomplete: 'off', style: 'width:100%;font-size:24px' });
  const tail = h('input', { class: 'input', placeholder: '전화번호 뒤 4자리 (모르면 비워 두세요)', inputmode: 'numeric', maxlength: '4', autocomplete: 'off', style: 'width:100%' });
  const body = h('div', { style: 'display:flex;flex-direction:column;gap:12px' },
    h('p', { class: 'help' }, `${ui.program} 명단에 없는 분을 오늘 출석으로 기록합니다. 담당자가 나중에 확인할 수 있게 표시가 남습니다.`),
    name, tail);
  setTimeout(() => name.focus(), 50);
  const ok = await modal('명단에 없는 분', body, [{ label: '닫기', value: false }, { label: '출석 기록', value: true, primary: true }]);
  const nm = name.value.trim().replace(/\s+/g, ' ');
  if (!ok || !nm) return;
  const last4 = tail.value.replace(/\D/g, '').slice(-4);
  const m = store.addMember(ui.program, nm, last4.length === 4 ? last4 : '', true);
  store.setAttendance(dateKey(), m.id, true);
  toast(`${m.name} 님 출석!`);
  ui.query = '';
  updateResults();
}

let wakeLock;
async function keepScreenOn() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    }
  } catch {}
}

/* ---------- 관리 화면 ---------- */

async function openAdmin() {
  if (!ui.unlocked) {
    if (!state.pin) {
      const a = await askPin('관리 비밀번호 만들기', '담당자만 아는 숫자 4자리를 정해 주세요');
      if (!a) return;
      const b = await askPin('한 번 더 입력', '확인을 위해 같은 숫자를 다시 눌러 주세요');
      if (a !== b) return toast('두 번 입력한 숫자가 달라요. 다시 해 주세요.', { info: true });
      state.pin = a;
      store.save();
    } else {
      let hint = '';
      for (;;) {
        const p = await askPin('관리 비밀번호', hint);
        if (p == null) return;
        if (p === state.pin) break;
        hint = '비밀번호가 맞지 않습니다';
      }
    }
    ui.unlocked = true;
  }
  ui.view = 'admin';
  render();
}

function closeAdmin() {
  ui.unlocked = false;
  ui.view = 'check';
  render();
}

const TABS = [
  ['roster', '명단 · 수업'],
  ['grid', '출석 현황'],
  ['export', '출석부 저장 · 합치기'],
  ['settings', '설정'],
];

function renderAdmin() {
  const panel = h('div', { class: 'panel' });
  mount(
    h('header', { class: 'top' },
      h('div', { class: 'prog-btn' }, '관리'),
      state.device && h('div', { class: 'device' }, state.device),
      h('div', { class: 'spacer' }),
      h('button', { class: 'btn primary', onclick: closeAdmin }, '출석 체크로 돌아가기')),
    h('div', { class: 'admin' },
      h('nav', { class: 'tabs', role: 'tablist' },
        TABS.map(([id, label]) => h('button', { role: 'tab', 'aria-selected': String(ui.tab === id), onclick: () => { ui.tab = id; render(); } }, label))),
      panel));
  ({ roster: tabRoster, grid: tabGrid, export: tabExport, settings: tabSettings })[ui.tab](panel);
}

/* 파일 불러오기: 이 앱이 저장한 출석부면 합치기, 아니면 명단 */
async function importFile() {
  const file = await pickFile();
  if (!file) return;
  let sheets;
  try {
    sheets = await readFile(file);
  } catch (e) {
    return modal('파일을 읽지 못했습니다', e.message || String(e));
  }
  let backup = null;
  try { backup = findBackup(sheets); } catch {}
  if (backup) return mergeBackup(backup, file.name);

  const { roster, notes } = parseRoster(sheets);
  const programs = Object.keys(roster);
  if (!programs.length) return modal('명단을 찾지 못했습니다', '엑셀 첫 부분에 "이름"과 "전화번호" 제목 칸이 있는지 확인해 주세요.\n[빈 명단 양식 받기]로 받은 양식을 쓰면 가장 확실합니다.' + (notes.length ? '\n\n' + notes.join('\n') : ''));

  const checks = {};
  const colors = {};
  // 새 수업에는 아직 안 쓴 색을 무지개 순서로 미리 골라 둔다 (바꿀 수 있음)
  const used = new Set(store.programNames().map((n) => state.programs[n].color));
  const nextColor = () => {
    const i = store.PALETTE.findIndex((_, k) => !used.has(k));
    const c = i >= 0 ? i : used.size % store.PALETTE.length;
    used.add(c);
    return c;
  };
  const body = h('div', {},
    h('p', { class: 'help' }, `'${file.name}'에서 찾은 수업입니다. 체크한 수업은 명단이 이 파일 내용으로 바뀝니다. 지난 출석 기록은 그대로 남습니다.`),
    h('div', { style: 'display:flex;flex-direction:column;gap:8px;margin:12px 0' },
      programs.map((p) => {
        const exists = state.programs[p] && !state.programs[p].deleted;
        const before = store.membersOf(p).length;
        const cb = h('input', { type: 'checkbox', checked: true, style: 'width:24px;height:24px' });
        checks[p] = cb;
        if (!exists) colors[p] = nextColor();
        return h('div', { class: 'import-row' },
          h('label', { style: 'display:flex;gap:12px;align-items:center;font-size:19px' },
            cb, h('b', {}, p), h('span', { class: 'help', style: 'margin:0' }, `${roster[p].length}명` + (exists ? ` (지금 ${before}명)` : ' (새 수업)'))),
          !exists && h('div', { class: 'row', style: 'margin:4px 0 0 36px' },
            h('span', { class: 'help', style: 'margin:0' }, '색깔'),
            swatches(colors[p], (i) => (colors[p] = i))));
      })),
    notes.length && h('div', { class: 'notes' }, notes.map((n) => h('div', {}, '• ' + n))),
    h('p', { class: 'help' }, '생년월일·금액·결제 정보는 읽지 않고, 전화번호도 뒷 4자리만 이 기기에 저장합니다.'));
  const ok = await modal('명단 불러오기', body, [{ label: '취소', value: false }, { label: '명단 적용', value: true, primary: true }]);
  if (!ok) return;
  const chosen = Object.fromEntries(programs.filter((p) => checks[p].checked).map((p) => [p, roster[p]]));
  if (!Object.keys(chosen).length) return;
  for (const p of Object.keys(chosen)) if (p in colors) store.ensureProgram(p, { color: colors[p] });
  const r = store.applyRoster(chosen);
  toast(`명단 적용 완료 (추가 ${r.added}명, 빠짐 ${r.removed}명)`, { info: true });
  render();
}

async function mergeBackup(data, filename) {
  if (!!data.demo !== store.isDemo) {
    return modal('합칠 수 없는 파일', data.demo
      ? `'${filename}'은 체험 모드에서 저장한 가상 데이터 파일입니다. 실제 출석부에는 합칠 수 없습니다.`
      : `'${filename}'은 실제 출석 기록 파일입니다. 체험 모드에는 합칠 수 없습니다.`);
  }
  const ok = await confirmBox('다른 기기 기록 합치기',
    `'${filename}'은 출석부 앱이 저장한 파일입니다.\n이 파일의 명단과 출석 기록을 이 기기에 합칠까요?\n(같은 칸은 더 나중에 수정된 쪽으로 맞춰집니다)`, '합치기');
  if (!ok) return;
  const r = store.mergeData(data);
  await modal('합치기 완료', `새로 들어온 출석 기록: ${r.records}건${data.device ? `\n(보낸 기기: ${data.device})` : ''}`);
  render();
}

function tabRoster(panel) {
  panel.append(
    h('div', { class: 'box' },
      h('h3', {}, '명단 불러오기'),
      h('p', {}, '프로그램 신청 명단 엑셀(.xlsx)을 고르세요. "이름", "전화번호", "프로그램명" 제목 칸을 찾아 자동으로 수업별 명단을 만듭니다. 프로그램명 칸이 없으면 시트 이름을 수업 이름으로 씁니다.'),
      h('p', {}, '분기나 달이 바뀌어 명단이 달라지면 새 명단 파일을 다시 불러오면 됩니다.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: importFile }, '명단 엑셀 불러오기'),
        h('button', { class: 'btn', onclick: addProgramDialog }, '+ 수업 직접 추가'),
        h('button', { class: 'btn', onclick: () => download(rosterTemplate(), '출석부_명단양식.xlsx') }, '빈 명단 양식 받기'))));

  const names = store.programNames();
  if (!names.length) return;
  panel.append(h('h3', { style: 'margin:8px 0 0' }, `수업 ${names.length}개`));
  for (const name of names) panel.append(programBox(name));
}

/** 수업 직접 추가: 이름, 색깔, 요일별 시간, 강사 */
async function addProgramDialog() {
  let color = store.freeColor();
  let schedule = { days: [], times: {} };
  const nameInput = h('input', { class: 'input', placeholder: '예: 노래교실 수요반', maxlength: '30', style: 'width:100%' });
  const teacherInput = h('input', { class: 'input', placeholder: '강사 이름 (선택)', maxlength: '20' });
  const err = h('div', { class: 'pin-err', style: 'text-align:left' });
  const preview = h('div', { class: 'color-preview' });
  const drawPreview = () => {
    preview.style.cssText = paletteVars(store.PALETTE[color]);
    preview.textContent = nameInput.value.trim() || '수업 이름';
  };
  nameInput.addEventListener('input', drawPreview);
  drawPreview();
  const body = h('div', { class: 'form' },
    h('label', { class: 'field' }, '수업 이름', nameInput),
    h('div', { class: 'field' }, '수업 색깔', swatches(color, (i) => { color = i; drawPreview(); }), preview),
    h('div', { class: 'field' }, '수업 요일과 시간', scheduleEditor(schedule, (s) => (schedule = s))),
    h('label', { class: 'field' }, '강사', teacherInput),
    h('p', { class: 'help' }, '명단은 추가한 뒤 [명단 보기 · 고치기]에서 한 분씩 넣거나, 명단 엑셀을 불러와 채웁니다.'),
    err);
  setTimeout(() => nameInput.focus(), 50);
  const ok = await modal('수업 추가', body, [
    { label: '취소', value: false },
    { label: '수업 추가', primary: true, value: () => {
      const name = nameInput.value.trim().replace(/\s+/g, ' ');
      if (!name) { err.textContent = '수업 이름을 적어 주세요.'; return KEEP_OPEN; }
      if (store.programNames().includes(name)) { err.textContent = '같은 이름의 수업이 이미 있습니다.'; return KEEP_OPEN; }
      store.addProgram(name, { color, ...schedule, teacher: teacherInput.value.trim() });
      return name;
    } },
  ]);
  if (ok) { toast(`'${ok}' 수업을 추가했습니다`, { info: true }); render(); }
}

function programBox(name) {
  const p = state.programs[name];
  const members = store.membersOf(name);
  const extra = members.filter((m) => m.extra).length;
  const box = h('div', { class: 'box prog-box', style: colorVars(name) });
  const teacherInput = h('input', { class: 'input', value: p.teacher || '', placeholder: '강사 이름', onchange: (e) => store.updateProgram(name, { teacher: e.target.value.trim() }) });
  const upcomingOff = (p.off || []).filter((d) => d >= dateKey());
  const holidayCb = h('input', { type: 'checkbox', checked: !!p.holidayClass, style: 'width:22px;height:22px',
    onchange: (e) => store.updateProgram(name, { holidayClass: e.target.checked }) });
  box.append(
    h('div', { class: 'prog-head' },
      h('h3', {}, name),
      h('span', { class: 'cnt' }, `${members.length}명` + (extra ? ` (명단 외 추가 ${extra}명)` : ''))),
    h('div', { class: 'row' },
      h('span', { class: 'label' }, '수업 색깔'),
      swatches(p.color ?? 0, (i) => {
        store.updateProgram(name, { color: i });
        box.style.cssText = colorVars(name);
      })),
    h('div', { class: 'row', style: 'align-items:flex-start' },
      h('span', { class: 'label' }, '요일·시간'),
      scheduleEditor(p, (s) => store.updateProgram(name, { ...s, time: '' }))),
    h('div', { class: 'row' },
      h('span', { class: 'label' }, '강사'), teacherInput),
    h('div', { class: 'row' },
      h('span', { class: 'label' }, '휴강일'),
      h('button', { class: 'btn small', onclick: () => offDaysDialog(name) }, '달력에서 고르기'),
      h('span', { class: 'help', style: 'margin:0' },
        upcomingOff.length
          ? `다가오는 휴강 ${upcomingOff.length}일: ${upcomingOff.slice(0, 6).map((d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`).join(', ')}${upcomingOff.length > 6 ? ' …' : ''}`
          : '다가오는 휴강일 없음')),
    h('div', { class: 'row' },
      h('span', { class: 'label' }, '수업 횟수'),
      h('span', { class: 'help', style: 'margin:0' }, monthCounts(name))),
    h('div', { class: 'row' },
      h('span', { class: 'label' }, '공휴일'),
      state.holidaysOff
        ? h('label', { style: 'display:flex;gap:8px;align-items:center' }, holidayCb, '공휴일에도 이 수업을 함 (체크하지 않으면 공휴일은 자동으로 휴강)')
        : h('span', { class: 'help', style: 'margin:0' }, '공휴일 자동 휴강이 꺼져 있습니다 ([설정]에서 켤 수 있음)')),
    h('div', { class: 'row' },
      h('button', { class: 'btn small', onclick: () => memberDialog(name) }, '명단 보기 · 고치기'),
      h('button', { class: 'btn small danger', onclick: async () => {
        if (await confirmBox('수업 삭제', `'${name}' 수업을 목록에서 지울까요?\n지난 출석 기록은 남아 있어 같은 이름으로 명단을 다시 불러오면 이어집니다.`, '삭제', true)) {
          store.deleteProgram(name);
          render();
        }
      } }, '수업 삭제')));
  return box;
}

/** '11월 8회(공휴일 등 1회 제외) · 12월 9회 · 1월 8회' */
function monthCounts(program) {
  if (!state.programs[program].days?.length) return '수업 요일을 정하면 달마다 수업 횟수가 나옵니다';
  const now = new Date();
  return [0, 1, 2].map((k) => {
    const month = dateKey(new Date(now.getFullYear(), now.getMonth() + k, 1)).slice(0, 7);
    const { held, offCount } = sessions(program, month, 1);
    return `${Number(month.slice(5))}월 ${held.length}회${offCount ? `(${offCount}회 쉼)` : ''}`;
  }).join(' · ');
}

/** 달력에서 휴강일 여러 날을 한 번에 고르기 */
async function offDaysDialog(name) {
  const p = state.programs[name];
  const picked = new Set(p.off || []);
  const hasDays = p.days?.length > 0;
  let month = dateKey().slice(0, 7);
  const title = h('b', {});
  const grid = h('div', { class: 'off-grid' });
  const summary = h('p', { class: 'help' });
  const draw = () => {
    const [y, m] = month.split('-').map(Number);
    title.textContent = `${y}년 ${m}월`;
    const startPad = new Date(y, m - 1, 1).getDay();
    const last = new Date(y, m, 0).getDate();
    const cells = WEEKDAYS.map((w, i) => h('div', { class: 'cal-wd' + (i === 0 ? ' sun' : i === 6 ? ' sat' : '') }, w));
    for (let i = 0; i < startPad; i++) cells.push(h('div'));
    for (let d = 1; d <= last; d++) {
      const key = `${month}-${String(d).padStart(2, '0')}`;
      const wd = (startPad + d - 1) % 7;
      const classDay = !hasDays || p.days.includes(wd);
      const hol = state.holidaysOff && !p.holidayClass ? holidayName(key) : null;
      if (hol && !picked.has(key)) {
        // 공휴일은 이미 자동으로 쉬므로 고를 필요가 없다
        cells.push(h('div', { class: 'off-day hol' + (classDay ? ' class-day' : ''), title: hol, 'aria-label': `${dateLabel(key)} ${hol} 공휴일 자동 휴강` },
          h('span', {}, d), h('small', {}, '공휴일')));
        continue;
      }
      cells.push(h('button', {
        type: 'button',
        class: 'off-day' + (classDay ? ' class-day' : '') + (picked.has(key) ? ' on' : '') + (key === dateKey() ? ' today' : ''),
        disabled: !classDay && !picked.has(key),
        'aria-pressed': String(picked.has(key)),
        'aria-label': `${dateLabel(key)}${picked.has(key) ? ' 휴강' : ''}`,
        onclick: () => { picked.has(key) ? picked.delete(key) : picked.add(key); draw(); },
      }, h('span', {}, d), picked.has(key) && h('small', {}, '휴강')));
    }
    grid.replaceChildren(...cells);
    const inMonth = [...picked].filter((k) => k.startsWith(month)).length;
    summary.textContent = `이 달 휴강 ${inMonth}일 · 전체 ${picked.size}일 선택됨`;
  };
  const shift = (delta) => {
    const [y, m] = month.split('-').map(Number);
    month = dateKey(new Date(y, m - 1 + delta, 1)).slice(0, 7);
    draw();
  };
  draw();
  const body = h('div', { style: colorVars(name) },
    h('p', { class: 'help' }, hasDays
      ? `${store.scheduleText(p)} 수업 날짜만 고를 수 있습니다. 휴강할 날을 모두 누른 뒤 [저장]을 누르세요. 다시 누르면 취소됩니다.`
      : '휴강할 날을 모두 누른 뒤 [저장]을 누르세요. 수업 요일을 정해 두면 수업 날짜만 고를 수 있어 더 편합니다.'),
    h('div', { class: 'cal-nav', style: 'justify-content:center;margin:8px 0' },
      h('button', { type: 'button', class: 'btn small', 'aria-label': '이전 달', onclick: () => shift(-1) }, '‹'),
      title,
      h('button', { type: 'button', class: 'btn small', 'aria-label': '다음 달', onclick: () => shift(1) }, '›')),
    grid,
    summary);
  const ok = await modal(`${name} 휴강일`, body, [{ label: '취소', value: false }, { label: '저장', value: true, primary: true }]);
  if (!ok) return;
  store.updateProgram(name, { off: [...picked].sort() });
  toast(`휴강일 ${picked.size}일로 저장했습니다`, { info: true });
  render();
}

/** 명단을 엑셀 화면처럼 보여 주고, 칸을 눌러 바로 고친다 */
function memberDialog(program) {
  const filter = h('input', { class: 'input', placeholder: '이름 찾기 (초성도 됨: ㄱㅁㅈ)', style: 'flex:1;min-width:160px' });
  const count = h('span', { class: 'help', style: 'margin:0' });
  const tbody = h('tbody');
  const err = h('div', { class: 'pin-err', style: 'text-align:left' });

  const cellInput = (value, attrs, commit) => {
    const input = h('input', { value, ...attrs });
    input.addEventListener('keydown', (e) => e.key === 'Enter' && input.blur());
    input.addEventListener('change', () => commit(input));
    return input;
  };

  const draw = () => {
    const all = store.membersOf(program);
    const dup = store.duplicateNames(all);
    const q = filter.value.trim();
    const rows = q ? all.filter((m) => matchName(m.name, q)) : all;
    count.textContent = q ? `${rows.length}명 / 전체 ${all.length}명` : `전체 ${all.length}명`;
    tbody.replaceChildren(...rows.map((m) => {
      const n = all.indexOf(m) + 1;
      const save = (nameEl, tailEl) => {
        const name = nameEl.value.trim().replace(/\s+/g, ' ');
        const tail = tailEl.value.replace(/\D/g, '');
        if (!name || (tail && tail.length !== 4)) {
          err.textContent = !name ? '이름은 비울 수 없습니다.' : '전화번호 뒷자리는 숫자 4자리로 적어 주세요.';
          nameEl.value = m.name; tailEl.value = m.last4;
          return;
        }
        const r = store.renameMember(m.id, name, tail);
        if (r === false) {
          err.textContent = `${name}${tail ? `(${tail})` : ''} 님이 이미 명단에 있습니다.`;
          nameEl.value = m.name; tailEl.value = m.last4;
          return;
        }
        err.textContent = '';
        draw();
      };
      let nameEl;
      let tailEl;
      nameEl = cellInput(m.name, { 'aria-label': `${n}행 이름`, maxlength: '20' }, () => save(nameEl, tailEl));
      tailEl = cellInput(m.last4, { 'aria-label': `${n}행 전화번호 뒷자리`, inputmode: 'numeric', maxlength: '4' }, () => save(nameEl, tailEl));
      return h('tr', { class: dup.has(m.name) ? 'dup' : '' },
        h('th', { class: 'rn' }, n + 1),
        h('td', {}, n),
        h('td', {}, nameEl),
        h('td', {}, tailEl),
        h('td', { class: 'ro' }, program),
        h('td', { class: 'ro' }, [m.extra && '명단 외 추가', dup.has(m.name) && '동명이인'].filter(Boolean).join(', ')),
        h('td', { class: 'act' }, h('button', { type: 'button', 'aria-label': `${m.name} 명단에서 빼기`, onclick: async () => {
          if (await confirmBox('명단에서 빼기', `${m.name} 님을 ${program} 명단에서 뺄까요?\n지난 출석 기록은 남습니다.`, '빼기', true)) { store.removeMember(m.id); draw(); }
        } }, '빼기')));
    }));
    // 맨 아래 빈 줄: 새로 추가
    const nm = h('input', { placeholder: '새 이름', 'aria-label': '추가할 이름', maxlength: '20' });
    const tl = h('input', { placeholder: '뒷 4자리', 'aria-label': '추가할 분 전화번호 뒷자리', inputmode: 'numeric', maxlength: '4' });
    const add = () => {
      const name = nm.value.trim().replace(/\s+/g, ' ');
      const tail = tl.value.replace(/\D/g, '');
      if (!name) return;
      if (tail && tail.length !== 4) { err.textContent = '전화번호 뒷자리는 숫자 4자리로 적어 주세요.'; return; }
      if (state.members[store.memberId(program, name, tail)]?.active) { err.textContent = '이미 명단에 있는 분입니다.'; return; }
      store.addMember(program, name, tail);
      err.textContent = '';
      filter.value = '';
      draw();
      tbody.querySelector('tr.new input')?.focus();
    };
    [nm, tl].forEach((el) => el.addEventListener('keydown', (e) => e.key === 'Enter' && add()));
    tbody.append(h('tr', { class: 'new' },
      h('th', { class: 'rn' }, '+'),
      h('td', {}, ''),
      h('td', {}, nm),
      h('td', {}, tl),
      h('td', { class: 'ro' }, program),
      h('td', { class: 'ro' }, ''),
      h('td', { class: 'act' }, h('button', { type: 'button', class: 'add', onclick: add }, '추가'))));
  };
  filter.addEventListener('input', draw);
  draw();

  const cols = ['', 'A', 'B', 'C', 'D', 'E', ''];
  const body = h('div', {},
    h('p', { class: 'help' }, '명단 엑셀과 같은 모양입니다. 이름이나 뒷자리 칸을 눌러 고치면 바로 저장되고, 그분의 지난 출석 기록도 함께 옮겨집니다. 맨 아래 줄에서 새로 추가합니다.'),
    h('div', { class: 'row', style: 'margin:0 0 8px' }, filter, count,
      h('button', { type: 'button', class: 'btn small', onclick: () => download(rosterSheet(program), `${store.isDemo ? '체험_' : ''}명단_${program}.xlsx`) }, '엑셀로 받기')),
    h('div', { class: 'xl-wrap' },
      h('table', { class: 'xl' },
        h('thead', {},
          h('tr', { class: 'letters' }, cols.map((c) => h('th', {}, c))),
          h('tr', {},
            h('th', { class: 'rn' }, '1'),
            ['번호', '이름', '전화번호 뒷자리', '프로그램명', '비고'].map((t) => h('th', { class: 'hd' }, t)),
            h('th', { class: 'hd' }, ''))),
        tbody)),
    err,
    h('p', { class: 'help' }, '이 기기에는 이름·뒷자리·수업만 저장되므로 원본 엑셀의 생년월일·금액·결제 칸은 나오지 않습니다.'));
  modal(`${program} 명단`, body, [{ label: '닫기', value: true, primary: true }], { wide: true }).then(render);
}

function tabGrid(panel) {
  const names = store.programNames();
  if (!names.length) return panel.append(h('div', { class: 'box' }, h('p', {}, '명단을 먼저 불러와 주세요.')));
  if (!names.includes(ui.gridProgram)) ui.gridProgram = ui.program && names.includes(ui.program) ? ui.program : names[0];
  const program = ui.gridProgram;
  const p = state.programs[program];
  const dates = classDates(program, ui.gridMonth, 1);
  const why = Object.fromEntries(dates.map((d) => [d, store.offReason(program, d)]));
  const off = new Set(dates.filter((d) => why[d]));
  const heldCount = sessions(program, ui.gridMonth, 1).held.length;
  const members = store.membersOf(program, { includeInactive: true }).filter((m) => m.active || dates.some((d) => store.getRecord(d, m.id)));
  const dup = store.duplicateNames(members);

  panel.append(
    h('div', { class: 'row', style: 'margin:0' },
      h('label', { class: 'field' }, '수업',
        h('select', { onchange: (e) => { ui.gridProgram = e.target.value; render(); } },
          names.map((n) => h('option', { value: n, selected: n === program }, n)))),
      h('label', { class: 'field' }, '달',
        h('input', { type: 'month', value: ui.gridMonth, onchange: (e) => { if (e.target.value) { ui.gridMonth = e.target.value; render(); } } }))),
    h('p', { class: 'help' }, '칸을 누르면 출석(○)과 결석이 바뀝니다. 지난 날짜를 고칠 때 쓰세요.'),
    dates.length > 0 && h('p', { class: 'count-note' }, `이 달 수업 ${heldCount}회` + (dates.length - heldCount ? ` (휴강·공휴일 ${dates.length - heldCount}회 제외)` : '')));

  if (!dates.length) {
    panel.append(h('div', { class: 'box' }, h('p', {}, '이 달에 표시할 수업 날짜가 없습니다. [명단 · 수업] 탭에서 수업 요일을 선택해 주세요.')));
    return;
  }
  const table = h('table', { class: 'sheet' },
    h('thead', {}, h('tr', {},
      h('th', { class: 'name' }, `이름 (${members.length})`),
      dates.map((d) => h('th', { class: off.has(d) ? 'off' : '', title: why[d] || '' }, `${Number(d.slice(8))}`, h('br'), off.has(d) ? offShort(why[d]) : WEEKDAYS[store.parseDate(d).getDay()])),
      h('th', {}, '계', h('br'), `/${heldCount}`))),
    h('tbody', {}, members.map((m) => {
      let total = 0;
      const cells = dates.map((d) => {
        const on = !!store.getRecord(d, m.id);
        if (on) total++;
        return h('td', { class: off.has(d) ? 'off' : '' },
          h('button', { 'aria-label': `${m.name} ${d} ${on ? '출석' : '결석'}`, onclick: () => { store.setAttendance(d, m.id, !on); render(); } }, on ? '○' : ''));
      });
      return h('tr', {},
        h('td', { class: 'name' + (m.active ? '' : ' inactive') }, m.name, dup.has(m.name) && m.last4 ? ` (${m.last4})` : '', m.extra ? ' *' : ''),
        cells,
        h('td', {}, total));
    })),
    h('tfoot', {}, h('tr', {},
      h('td', { class: 'name' }, '출석 인원'),
      dates.map((d) => h('td', {}, store.countPresent(d, members))),
      h('td', {}, ''))));
  panel.append(h('div', { class: 'sheet-wrap' }, table));
}

function tabExport(panel) {
  const names = store.programNames();
  const stale = !state.lastExport || Date.now() - state.lastExport > 14 * 864e5;
  panel.append(
    h('div', { class: 'box' },
      h('h3', {}, '출석부 엑셀로 저장'),
      h('p', {}, '수업별로 시트가 나뉜 출석부 엑셀이 만들어집니다. 출석 기록이 없어도 명단과 수업 날짜가 채워진 빈 출석부로 인쇄할 수 있습니다.'),
      h('div', { class: 'row' },
        h('label', { class: 'field' }, '수업',
          h('select', { onchange: (e) => (ui.bookProgram = e.target.value) },
            h('option', { value: '' }, '전체 수업'),
            names.map((n) => h('option', { value: n, selected: n === ui.bookProgram }, n)))),
        h('label', { class: 'field' }, '시작 달',
          h('input', { type: 'month', value: ui.bookMonth, onchange: (e) => e.target.value && (ui.bookMonth = e.target.value) })),
        h('label', { class: 'field' }, '기간',
          h('select', { onchange: (e) => (ui.bookMonths = Number(e.target.value)) },
            h('option', { value: '1', selected: ui.bookMonths === 1 }, '1개월'),
            h('option', { value: '3', selected: ui.bookMonths === 3 }, '3개월 (분기)')))),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', disabled: !names.length, onclick: saveBook }, '출석부 엑셀 저장')),
      h('p', { class: stale ? 'notes' : 'help' }, `마지막 저장: ${fmtTime(state.lastExport)}` + (stale ? ' — 기기 고장에 대비해 2주에 한 번은 저장해 두세요.' : ''))),
    h('div', { class: 'box' },
      h('h3', {}, '태블릿 2대의 기록 합치기'),
      h('p', {}, '태블릿마다 기록이 따로 쌓입니다. 한 달에 한 번(또는 필요할 때) 아래처럼 합칩니다.'),
      h('ol', { class: 'help', style: 'padding-left:22px' },
        h('li', {}, '각 태블릿에서 [출석부 엑셀 저장]을 누릅니다.'),
        h('li', {}, '저장된 파일을 담당자 PC 또는 복지관 내부 저장소로 옮깁니다.'),
        h('li', {}, 'PC(또는 한쪽 태블릿)에서 이 화면을 열고 [다른 기기 파일 합치기]로 다른 기기의 파일을 불러옵니다.'),
        h('li', {}, '합친 뒤 다시 [출석부 엑셀 저장]을 누르면 두 기기 기록이 모두 담긴 출석부가 됩니다.')),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: importFile }, '다른 기기 파일 합치기'))));
}

function saveBook() {
  const names = store.programNames();
  const programs = ui.bookProgram && names.includes(ui.bookProgram) ? [ui.bookProgram] : names;
  const blob = buildBook(programs, ui.bookMonth, ui.bookMonths);
  const [y, m] = ui.bookMonth.split('-');
  const period = ui.bookMonths === 1 ? `${y}년${Number(m)}월` : `${y}년${Number(m)}월부터3개월`;
  const now = new Date();
  const stamp = `${dateKey(now).replace(/-/g, '')}-${store.timeStr(now).replace(':', '')}`;
  const who = state.device ? `_${state.device.replace(/[\\/:*?"<>|\s]/g, '')}` : '';
  download(blob, `${store.isDemo ? '체험_' : ''}출석부_${ui.bookProgram || '전체'}_${period}${who}_${stamp}.xlsx`);
  store.markExported();
  toast('출석부를 저장했습니다 (다운로드 폴더)', { info: true });
  render();
}

function tabSettings(panel) {
  const device = h('input', { class: 'input', value: state.device, placeholder: '예: 태블릿1', maxlength: '20' });
  panel.append(
    h('div', { class: 'box' },
      h('h3', {}, '이 기기 이름'),
      h('p', {}, '태블릿이 2대일 때 어느 기기의 파일인지 구분하려고 씁니다. 저장 파일 이름에도 붙습니다.'),
      h('div', { class: 'row' }, device,
        h('button', { class: 'btn', onclick: () => { state.device = device.value.trim(); store.save(); toast('저장했습니다', { info: true }); render(); } }, '저장'))),
    h('div', { class: 'box' },
      h('h3', {}, '관리 비밀번호 바꾸기'),
      h('p', {}, '봉사자분들이 실수로 명단을 바꾸지 않도록 막는 용도입니다.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: async () => {
          const a = await askPin('새 비밀번호');
          if (!a) return;
          const b = await askPin('한 번 더 입력');
          if (a !== b) return toast('두 번 입력한 숫자가 달라요', { info: true });
          state.pin = a; store.save(); toast('비밀번호를 바꿨습니다', { info: true });
        } }, '비밀번호 바꾸기'))),
    h('div', { class: 'box' },
      h('h3', {}, '이 기기의 모든 기록 지우기'),
      h('p', {}, '기기를 더 이상 쓰지 않거나 다른 곳에 넘길 때 사용하세요. 명단과 출석 기록이 이 기기에서 모두 지워지고 되돌릴 수 없습니다. 지우기 전에 [출석부 엑셀 저장]을 먼저 해 두세요.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn danger', onclick: async () => {
          const input = h('input', { class: 'input', placeholder: '전체삭제', style: 'width:100%' });
          const ok = await modal('모든 기록 지우기', h('div', {}, h('p', { class: 'msg' }, '확인을 위해 아래 칸에 "전체삭제"라고 적어 주세요.'), input),
            [{ label: '취소', value: false }, { label: '지우기', value: () => input.value.trim() === '전체삭제', danger: true }]);
          if (!ok) return;
          store.resetAll();
          ui.unlocked = false; ui.view = 'check'; ui.program = null;
          render();
        } }, '모든 기록 지우기'))),
    holidayBox(),
    retentionBox(),
    diagnosticsBox(),
    h('p', { class: 'help' }, `출석부 앱 버전 ${APP_VERSION}. 이 앱은 명단과 출석 기록을 이 기기 안에만 저장하며 외부 서버로 보내지 않습니다(보내는 기능 자체가 막혀 있습니다). 저장 항목: 이름, 전화번호 뒷 4자리, 수업 이름, 출석 시각.`));
}

function holidayBox() {
  const cb = h('input', { type: 'checkbox', checked: state.holidaysOff, style: 'width:24px;height:24px',
    onchange: (e) => { state.holidaysOff = e.target.checked; store.save(); render(); } });
  const today = dateKey();
  const lastYear = Number(HOLIDAYS_UNTIL.slice(0, 4));
  const soonEnd = today >= `${lastYear}-10-01`; // 마지막 해 10월부터 다음 해 정보가 필요하다고 알림
  const upcoming = Object.entries(HOLIDAYS).filter(([d]) => d >= today).slice(0, 8);
  return h('div', { class: 'box' },
    h('h3', {}, '공휴일 자동 휴강'),
    h('label', { style: 'display:flex;gap:10px;align-items:center;font-size:18px;margin:8px 0' }, cb, '공휴일·대체공휴일·선거일에는 모든 수업을 휴강으로 표시'),
    h('p', {}, `수업마다 [명단 · 수업]에서 '공휴일에도 이 수업을 함'을 체크하면 그 수업만 예외가 됩니다. 공휴일 정보는 ${lastYear}년 12월까지 들어 있습니다.`),
    soonEnd && h('p', { class: 'notes' }, `${lastYear + 1}년 공휴일 정보가 아직 없습니다. 개발자에게 앱 업데이트를 요청해 주세요. 그동안은 [달력에서 고르기]로 직접 휴강일을 넣으면 됩니다.`),
    upcoming.length > 0 && h('p', {}, '다가오는 공휴일: ' + upcoming.map(([d, n]) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))} ${n}`).join(', ')),
    h('p', {}, '정부가 임시공휴일을 새로 정하면 [달력에서 고르기]로 그 날짜를 휴강으로 넣어 주세요.'));
}

function retentionBox() {
  const now = new Date();
  const cutoff = dateKey(new Date(now.getFullYear() - 1, now.getMonth(), 1));
  const old = Object.keys(state.records).filter((d) => d < cutoff).length;
  return h('div', { class: 'box' },
    h('h3', {}, '오래된 기록 정리'),
    h('p', {}, `개인정보는 필요한 기간만 보관하는 것이 좋습니다. ${cutoff.slice(0, 4)}년 ${Number(cutoff.slice(5, 7))}월 1일 이전(1년 넘은) 출석 기록을 이 기기에서 지웁니다. 지우기 전에 그 기간의 출석부 엑셀을 저장해 두세요.`),
    h('div', { class: 'row' },
      h('button', { class: 'btn', disabled: !old, onclick: async () => {
        if (!(await confirmBox('오래된 기록 정리', `${cutoff} 이전 ${old}일치 출석 기록을 지울까요?\n되돌릴 수 없습니다.`, '지우기', true))) return;
        const r = store.pruneBefore(cutoff);
        toast(`${r.days}일치 기록을 지웠습니다`, { info: true });
        render();
      } }, old ? `1년 지난 기록 지우기 (${old}일치)` : '1년 지난 기록 없음')));
}

function diagnosticsBox() {
  const d = store.diagnostics();
  const text = [
    `출석부 앱 버전: ${APP_VERSION}${store.isDemo ? ' (체험 모드)' : ''}`,
    `기기 이름: ${state.device || '-'}`,
    `수업: ${d.programs}개 / 명단: ${d.activeMembers}명 (지난 명단 포함 ${d.allMembers}명)`,
    `출석 기록: ${d.records}건, ${d.recordDays}일 (${d.firstDate} ~ ${d.lastDate})`,
    `저장 용량: 약 ${d.storageKB}KB`,
    `마지막 엑셀 저장: ${fmtTime(state.lastExport)}`,
    `오프라인 사용 준비: ${navigator.serviceWorker?.controller ? '됨' : '안 됨'}`,
    `브라우저: ${navigator.userAgent}`,
  ].join('\n');
  const area = h('textarea', { class: 'input', readonly: true, rows: '8', style: 'width:100%;font-size:14px;font-family:monospace' });
  area.value = text;
  return h('div', { class: 'box' },
    h('h3', {}, '문제가 생겼을 때'),
    h('p', {}, '개발자에게 아래 내용과 화면 사진만 보내 주세요. 이름·전화번호 같은 개인정보는 들어 있지 않습니다. 명단이나 출석부 엑셀 파일은 보내지 마세요.'),
    area,
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: async () => {
        try { await navigator.clipboard.writeText(text); }
        catch { area.select(); document.execCommand('copy'); }
        toast('복사했습니다. 문자나 카톡에 붙여 넣어 보내 주세요.', { info: true });
      } }, '내용 복사')));
}

/* ---------- 시작 ---------- */

store.load();
if (store.isDemo && !store.programNames().length) store.replaceState(makeDemoData());
render();

// 자정이 지나거나 화면이 다시 켜지면 날짜를 새로 그린다
let lastDay = dateKey();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  wakeLock = null;
  if (dateKey() !== lastDay) { lastDay = dateKey(); if (ui.view !== 'admin') render(); }
  if (ui.view === 'check') keepScreenOn();
});

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
