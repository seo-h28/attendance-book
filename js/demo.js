// 체험 모드용 가상 데이터. 실제 사람이 아닌 무작위로 만든 이름과 번호다.
import { dateKey, memberId, PALETTE } from './store.js';

export const DEMO_PIN = '0000';

const SUR = [...'김이박최정강조윤장임한오서신권황안송류홍'];
const GIVEN = ['미자', '영희', '순자', '옥순', '정숙', '영자', '말순', '춘자', '경자', '명숙',
  '철수', '영수', '만수', '광호', '상철', '꽃님', '복례', '점순', '덕자', '숙자', '금순', '봉남'];

// times: 요일별 수업 시간 (줌바댄스는 요일마다 시간이 다른 예)
const PROGRAMS = [
  { name: '노래교실', count: 112, times: { 3: '14:00-15:30' }, teacher: '한경주', rate: 0.85 },
  { name: '줌바댄스', count: 40, times: { 1: '10:40-11:30', 3: '13:00-13:50' }, teacher: '윤혜정', rate: 0.75 },
  { name: '파워로빅', count: 30, times: { 1: '09:30-10:20', 3: '09:30-10:20', 5: '09:30-10:20' }, teacher: '남현주', rate: 0.7 },
  { name: '서예교실', count: 18, times: { 2: '10:00-12:00' }, teacher: '박서연', rate: 0.8 },
  { name: '스마트폰교실', count: 15, times: { 4: '13:00-14:30' }, teacher: '이도윤', rate: 0.65 },
].map((p) => ({ ...p, days: Object.keys(p.times).map(Number) }));

// 매번 같은 결과가 나오는 난수 (새로 만들 때마다 seed를 바꿈)
function rng(seed) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

/** 지난달 1일부터 오늘까지 출석 기록이 채워진 가상 데이터 */
export function makeDemoData(seed = Date.now()) {
  const rand = rng(seed >>> 0);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const now = new Date();
  const today = dateKey(now);
  const u = Date.now();

  const programs = {};
  const members = {};
  const records = {};

  // 이번 달 안의 수업 날 하나씩을 휴강으로
  const offFor = (days) => {
    const cands = [];
    for (let d = 1; d <= 28; d++) {
      const dt = new Date(now.getFullYear(), now.getMonth(), d);
      if (days.includes(dt.getDay())) cands.push(dateKey(dt));
    }
    return [pick(cands)];
  };

  PROGRAMS.forEach((p, i) => {
    programs[p.name] = { days: p.days, times: { ...p.times }, teacher: p.teacher, off: offFor(p.days), color: i % PALETTE.length, u };
    const people = [];
    const seen = new Set();
    while (people.length < p.count) {
      const name = pick(SUR) + pick(GIVEN);
      const last4 = String(1000 + Math.floor(rand() * 9000));
      const k = name + last4;
      if (seen.has(k)) continue;
      seen.add(k);
      people.push({ name, last4 });
    }
    // 동명이인 예시 (노래교실)
    if (i === 0) people.push({ name: '김미지', last4: '1311' }, { name: '김미지', last4: '1322' });
    for (const x of people) {
      const id = memberId(p.name, x.name, x.last4);
      members[id] = { id, program: p.name, name: x.name, last4: x.last4, active: true, extra: false, u };
    }
  });

  // 출석 기록: 지난 수업은 대부분, 오늘 수업은 절반쯤 받은 상태
  const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  for (let d = new Date(start); dateKey(d) <= today; d.setDate(d.getDate() + 1)) {
    const key = dateKey(d);
    for (const p of PROGRAMS) {
      if (!p.days.includes(d.getDay()) || programs[p.name].off.includes(key)) continue;
      const rate = key === today ? p.rate * 0.5 : p.rate - 0.1 + rand() * 0.2;
      const day = (records[key] ||= {});
      for (const m of Object.values(members)) {
        if (m.program !== p.name || rand() > rate) continue;
        const [h, mm] = p.times[d.getDay()].split('-')[0].split(':').map(Number);
        const t = h * 60 + mm - 20 + Math.floor(rand() * 25);
        day[m.id] = { t: `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`, u, by: '체험' };
      }
    }
  }

  return { device: '체험용', pin: DEMO_PIN, programs, members, records, lastExport: 0 };
}
