import { holidayName } from './holidays.js';

// 데이터 저장소: 이 기기(태블릿/PC)의 브라우저 안에만 저장된다.
// 개인정보 최소화: 이름, 전화번호 뒷 4자리, 프로그램명만 보관한다.
// 주소 끝에 ?demo 를 붙이면 체험 모드: 실제 데이터와 완전히 따로 저장된다
export const isDemo = new URLSearchParams(location.search).has('demo');
const KEY = isDemo ? 'chulseokbu.demo' : 'chulseokbu.v1';

export const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

function empty() {
  // holidaysOff: 공휴일에는 모든 수업을 쉬는 것으로 볼지 (수업별로 '공휴일에도 수업'을 켤 수 있음)
  return { v: 1, device: '', pin: '', programs: {}, members: {}, records: {}, lastExport: 0, holidaysOff: true };
}

export let state = empty();

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) state = Object.assign(empty(), JSON.parse(raw));
  } catch (e) {
    console.error(e);
  }
  // 색깔 기능 이전에 만든 수업에도 색을 정해 준다
  for (const n of programNames()) if (state.programs[n].color == null) state.programs[n].color = freeColor(n);
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  return state;
}

export function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    return true;
  } catch (e) {
    alert('저장에 실패했습니다. 기기 저장 공간을 확인해 주세요.\n' + e.message);
    return false;
  }
}

export function resetAll() {
  state = empty();
  save();
}

/**
 * 기준 날짜 이전의 출석 기록을 지운다 (개인정보 보관 기간 관리).
 * 명단에서 이미 빠졌고 남은 기록도 없는 분은 이름까지 지운다.
 */
export function pruneBefore(cutoff) {
  let days = 0;
  for (const date of Object.keys(state.records)) {
    if (date < cutoff) { delete state.records[date]; days++; }
  }
  const stillUsed = new Set(Object.values(state.records).flatMap((d) => Object.keys(d)));
  let people = 0;
  for (const [id, m] of Object.entries(state.members)) {
    if (!m.active && !stillUsed.has(id)) { delete state.members[id]; people++; }
  }
  save();
  return { days, people };
}

/** 문제 신고용 요약. 이름·번호 같은 개인정보는 넣지 않는다. */
export function diagnostics() {
  const raw = (() => { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } })();
  const members = Object.values(state.members);
  const dates = Object.keys(state.records).sort();
  return {
    programs: programNames().length,
    activeMembers: members.filter((m) => m.active).length,
    allMembers: members.length,
    recordDays: dates.length,
    records: Object.values(state.records).reduce((n, d) => n + Object.values(d).filter((r) => !r.x).length, 0),
    firstDate: dates[0] || '-',
    lastDate: dates[dates.length - 1] || '-',
    storageKB: Math.round((raw.length * 2) / 1024),
  };
}

/** 체험 모드에서 가상 데이터로 통째로 바꾼다 */
export function replaceState(next) {
  state = Object.assign(empty(), next);
  save();
}

/* ---------- 날짜 ---------- */

const pad = (n) => String(n).padStart(2, '0');
export const dateKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const timeStr = (d = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
export function parseDate(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}
export function dateLabel(key) {
  const d = parseDate(key);
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEKDAYS[d.getDay()]})`;
}

/* ---------- 프로그램 / 명단 ---------- */

export const memberId = (program, name, last4) => `${program}|${name}|${last4}`;

export function programNames() {
  return Object.keys(state.programs)
    .filter((p) => !state.programs[p].deleted)
    .sort((a, b) => a.localeCompare(b, 'ko'));
}

// 수업별 색깔: 무지개 순서의 단색. ink = 그 색 위에 쓰는 글자색(밝은 색은 검정 글자)
// 수업이 7개를 넘으면 뒤의 색을 이어서 쓴다.
export const PALETTE = [
  { name: '빨강', c: '#d32f2f', ink: '#ffffff' },
  { name: '주황', c: '#f57c00', ink: '#1f2421' },
  { name: '노랑', c: '#fbc02d', ink: '#1f2421' },
  { name: '초록', c: '#2e7d32', ink: '#ffffff' },
  { name: '파랑', c: '#1565c0', ink: '#ffffff' },
  { name: '남색', c: '#283593', ink: '#ffffff' },
  { name: '보라', c: '#7b1fa2', ink: '#ffffff' },
  { name: '분홍', c: '#c2185b', ink: '#ffffff' },
  { name: '청록', c: '#00838f', ink: '#ffffff' },
  { name: '갈색', c: '#6d4c41', ink: '#ffffff' },
  { name: '회색', c: '#546e7a', ink: '#ffffff' },
];

/** 다른 수업이 아직 안 쓰는 색 중 첫 번째 */
export function freeColor(except) {
  const used = new Set(programNames().filter((n) => n !== except).map((n) => state.programs[n].color));
  const i = PALETTE.findIndex((_, k) => !used.has(k));
  return i >= 0 ? i : programNames().length % PALETTE.length;
}

export function colorOf(name) {
  return PALETTE[state.programs[name]?.color ?? 0] || PALETTE[0];
}

export function ensureProgram(name, init = {}) {
  if (!state.programs[name] || state.programs[name].deleted) {
    state.programs[name] = { days: [], times: {}, teacher: '', off: [], color: freeColor(name), ...init, u: Date.now() };
  }
  return state.programs[name];
}

/** 새 수업 만들기 (명단 없이) */
export function addProgram(name, init) {
  const p = ensureProgram(name, init);
  save();
  return p;
}

/**
 * 그날 그 수업이 쉬는 이유. 쉬지 않으면 null.
 * 담당자가 직접 정한 휴강일이 먼저, 그다음 공휴일.
 */
export function offReason(name, date) {
  const p = state.programs[name];
  if (!p) return null;
  if (p.off?.includes(date)) return '휴강';
  if (state.holidaysOff && !p.holidayClass) return holidayName(date);
  return null;
}

/* 요일별 수업 시간: times = {요일번호: '10:40-11:30'}. 예전 데이터의 time 은 모든 요일 공통 시간으로 본다. */
export function timeOn(p, weekday) {
  return p?.times?.[weekday] || p?.time || '';
}

export const sortDays = (days = []) => days.slice().sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));

/** '월·수 10:40-11:30' 또는 '월 10:40-11:30 · 수 14:00-15:30' */
export function scheduleText(p) {
  const days = sortDays(p?.days);
  if (!days.length) return '';
  const times = days.map((d) => timeOn(p, d));
  if (times.every((t) => t === times[0])) return `${days.map((d) => WEEKDAYS[d]).join('·')}${times[0] ? ' ' + times[0] : ''}`;
  return days.map((d, i) => `${WEEKDAYS[d]}${times[i] ? ' ' + times[i] : ''}`).join(' · ');
}

export function updateProgram(name, patch) {
  Object.assign(ensureProgram(name), patch, { u: Date.now() });
  save();
}

export function deleteProgram(name) {
  const now = Date.now();
  state.programs[name] = { ...state.programs[name], deleted: true, u: now };
  for (const m of Object.values(state.members)) if (m.program === name && m.active) Object.assign(m, { active: false, u: now });
  save();
}

/** 프로그램의 현재 명단 (가나다순) */
export function membersOf(program, { includeInactive = false } = {}) {
  return Object.values(state.members)
    .filter((m) => m.program === program && (includeInactive || m.active))
    .sort((a, b) => a.name.localeCompare(b.name, 'ko') || a.last4.localeCompare(b.last4));
}

/** 같은 프로그램 안에서 이름이 같은 사람이 있는지 */
export function duplicateNames(members) {
  const count = {};
  for (const m of members) count[m.name] = (count[m.name] || 0) + 1;
  return new Set(Object.keys(count).filter((n) => count[n] > 1));
}

export function addMember(program, name, last4, extra = false) {
  ensureProgram(program);
  const id = memberId(program, name, last4);
  state.members[id] = { id, program, name, last4, active: true, extra, u: Date.now() };
  save();
  return state.members[id];
}

/**
 * 이름·뒷자리 고치기. 출석 기록도 새 이름으로 옮긴다.
 * 예전 칸은 '지움'으로 남겨서 다른 태블릿과 합칠 때도 고친 내용이 이긴다.
 */
export function renameMember(id, name, last4) {
  const old = state.members[id];
  if (!old) return null;
  const newId = memberId(old.program, name, last4);
  if (newId === id) return old;
  if (state.members[newId]?.active) return false; // 같은 사람이 이미 있음
  const now = Date.now();
  state.members[newId] = { ...old, id: newId, name, last4, active: true, u: now };
  Object.assign(old, { active: false, u: now });
  for (const day of Object.values(state.records)) {
    const r = day[id];
    if (r && !r.x) {
      day[newId] = { ...r, u: now };
      day[id] = { x: 1, u: now };
    }
  }
  save();
  return state.members[newId];
}

export function removeMember(id) {
  const m = state.members[id];
  if (m) Object.assign(m, { active: false, u: Date.now() });
  save();
}

/**
 * 명단 적용: 선택한 프로그램의 명단을 새 명단으로 교체한다.
 * 빠진 사람은 '비활성'으로만 바꾸고 지난 출석 기록은 그대로 남긴다.
 */
export function applyRoster(roster /* {program: [{name,last4}]} */) {
  const now = Date.now();
  let added = 0;
  let removed = 0;
  for (const [program, people] of Object.entries(roster)) {
    ensureProgram(program);
    const keep = new Set();
    for (const p of people) {
      const id = memberId(program, p.name, p.last4);
      keep.add(id);
      const prev = state.members[id];
      if (!prev || !prev.active) added++;
      state.members[id] = { id, program, name: p.name, last4: p.last4, active: true, extra: false, u: now };
    }
    for (const m of Object.values(state.members)) {
      if (m.program === program && m.active && !keep.has(m.id)) {
        Object.assign(m, { active: false, u: now });
        removed++;
      }
    }
  }
  save();
  return { added, removed };
}

/* ---------- 출석 ---------- */

export function getRecord(date, id) {
  const r = state.records[date]?.[id];
  return r && !r.x ? r : null;
}

export function setAttendance(date, id, present) {
  const day = (state.records[date] ||= {});
  day[id] = present ? { t: timeStr(), u: Date.now(), by: state.device || '' } : { x: 1, u: Date.now() };
  save();
}

export function countPresent(date, members) {
  return members.filter((m) => getRecord(date, m.id)).length;
}

/**
 * 그날 있는(또는 있었던) 수업과 출석 현황.
 * 수업 요일이거나 실제 출석 기록이 있으면 그날 수업으로 본다.
 * @returns {{name:string, off:boolean, present:number, total:number}[]}
 */
export function daySummary(date) {
  const weekday = parseDate(date).getDay();
  const day = state.records[date] || {};
  const out = [];
  for (const name of programNames()) {
    const p = state.programs[name];
    const all = membersOf(name, { includeInactive: true });
    const present = all.filter((m) => day[m.id] && !day[m.id].x).length;
    const scheduled = p.days?.includes(weekday);
    if (!scheduled && !present) continue;
    // 총 인원: 지금 명단 + 그날 출석했지만 지금은 명단에서 빠진 분
    const total = all.filter((m) => m.active || (day[m.id] && !day[m.id].x)).length;
    const reason = offReason(name, date);
    out.push({ name, off: !!reason, reason, present, total, time: timeOn(p, weekday) });
  }
  // 그날 수업 시간 순서로 (시간이 없으면 뒤로)
  return out.sort((a, b) => (a.time || '99').localeCompare(b.time || '99') || a.name.localeCompare(b.name, 'ko'));
}

/* ---------- 다른 기기 기록 합치기 ---------- */

/** 나중에 바뀐 쪽이 이긴다 (u = 수정 시각) */
export function mergeData(other) {
  let records = 0;
  for (const [name, p] of Object.entries(other.programs || {})) {
    const mine = state.programs[name];
    if (!mine || (p.u || 0) > (mine.u || 0)) state.programs[name] = p;
  }
  for (const [id, m] of Object.entries(other.members || {})) {
    const mine = state.members[id];
    if (!mine || (m.u || 0) > (mine.u || 0)) state.members[id] = m;
  }
  for (const [date, day] of Object.entries(other.records || {})) {
    const mineDay = (state.records[date] ||= {});
    for (const [id, r] of Object.entries(day)) {
      const mine = mineDay[id];
      if (!mine || (r.u || 0) > (mine.u || 0)) {
        if (!r.x && (!mine || mine.x)) records++;
        mineDay[id] = r;
      }
    }
  }
  save();
  return { records };
}

/** 백업에 들어갈 데이터 (PIN 제외) */
export function exportData() {
  const { pin, ...rest } = state;
  return { ...rest, exportedAt: Date.now(), ...(isDemo ? { demo: true } : {}) };
}

export function markExported() {
  state.lastExport = Date.now();
  save();
}
