// 출석부 엑셀 만들기 (월별 또는 분기별)
import { S, colName, writeXlsx } from './xlsx.js';
import { state, membersOf, duplicateNames, getRecord, dateKey, parseDate, WEEKDAYS, exportData, scheduleText, offReason } from './store.js';
import { backupSheet } from './roster.js';

/** 기간 안의 수업 날짜: 수업 요일 + 실제 출석 기록이 있는 날 */
export function classDates(program, startMonth, months) {
  const p = state.programs[program] || { days: [] };
  const [y, m] = startMonth.split('-').map(Number);
  const start = new Date(y, m - 1, 1);
  const end = new Date(y, m - 1 + months, 1);
  const ids = new Set(membersOf(program, { includeInactive: true }).map((x) => x.id));
  const dates = new Set();
  for (let d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
    if (p.days.includes(d.getDay())) dates.add(dateKey(d));
  }
  for (const [date, day] of Object.entries(state.records)) {
    const d = parseDate(date);
    if (d >= start && d < end && Object.entries(day).some(([id, r]) => ids.has(id) && !r.x)) dates.add(date);
  }
  return [...dates].sort();
}

/**
 * 실제 수업 횟수: 수업 날짜 중 휴강·공휴일을 뺀 날.
 * 단, 쉬는 날이어도 출석 기록이 있으면 수업을 한 것으로 센다.
 */
export function sessions(program, startMonth, months) {
  const dates = classDates(program, startMonth, months);
  const ids = membersOf(program, { includeInactive: true }).map((m) => m.id);
  const heldOn = (d) => !offReason(program, d) || ids.some((id) => getRecord(d, id));
  const held = dates.filter(heldOn);
  return { dates, held, offCount: dates.length - held.length };
}

function programSheet(program, startMonth, months) {
  const p = state.programs[program] || { days: [], off: [] };
  const dates = classDates(program, startMonth, months);
  // 담당자가 정한 휴강일 + 공휴일
  const why = Object.fromEntries(dates.map((d) => [d, offReason(program, d)]));
  const off = new Set(dates.filter((d) => why[d]));
  const heldCount = sessions(program, startMonth, months).held.length;
  // 현재 명단 + 기간 안에 출석 기록이 있는 예전 명단
  const members = membersOf(program, { includeInactive: true }).filter(
    (mb) => mb.active || dates.some((d) => getRecord(d, mb.id)),
  );
  const dup = duplicateNames(members);

  const [y, m] = startMonth.split('-').map(Number);
  const lastMonth = new Date(y, m - 1 + months - 1, 1);
  const period =
    months === 1
      ? `${y}년 ${m}월`
      : `${y}년 ${m}월 ~ ${lastMonth.getFullYear() !== y ? lastMonth.getFullYear() + '년 ' : ''}${lastMonth.getMonth() + 1}월`;

  const FIRST = 3; // 번호, 이름, 구분
  const totalCol = FIRST + dates.length;
  const rows = [];
  const merges = [];
  const lastColName = colName(Math.max(totalCol, 5));

  rows[0] = [{ v: `${program} 출석부 (${period})`, s: S.title }];
  merges.push(`A1:${lastColName}1`);
  const info = [
    scheduleText(p),
    p.teacher ? `${p.teacher} 강사` : '',
    `등록 ${members.filter((x) => x.active).length}명`,
    `수업 ${heldCount}회` + (dates.length - heldCount ? ` (휴강·공휴일 ${dates.length - heldCount}회 제외)` : ''),
  ].filter(Boolean);
  rows[1] = [{ v: info.join('  /  '), s: S.info }];
  merges.push(`A2:${lastColName}2`);

  // 3행: 월, 4행: 일(요일)
  const head1 = [{ v: '번호', s: S.header }, { v: '이름', s: S.header }, { v: '구분', s: S.header }];
  const head2 = [{ v: '', s: S.header }, { v: '', s: S.header }, { v: '', s: S.header }];
  merges.push('A3:A4', 'B3:B4', 'C3:C4');
  let i = 0;
  while (i < dates.length) {
    const month = dates[i].slice(0, 7);
    let j = i;
    while (j < dates.length && dates[j].startsWith(month)) j++;
    for (let k = i; k < j; k++) {
      head1[FIRST + k] = { v: k === i ? `${Number(month.slice(5))}월` : '', s: S.header };
      const d = parseDate(dates[k]);
      head2[FIRST + k] = { v: `${d.getDate()}\n${off.has(dates[k]) ? (why[dates[k]] === '휴강' ? '휴강' : '공휴') : WEEKDAYS[d.getDay()]}`, s: off.has(dates[k]) ? S.off : S.header };
    }
    if (j - i > 1) merges.push(`${colName(FIRST + i)}3:${colName(FIRST + j - 1)}3`);
    i = j;
  }
  head1[totalCol] = { v: '출석', s: S.header };
  head2[totalCol] = { v: `/ ${heldCount}회`, s: S.header };
  rows[2] = head1;
  rows[3] = head2;

  members.forEach((mb, n) => {
    const row = [
      { v: n + 1, s: S.center },
      { v: mb.name + (mb.active ? '' : ' (취소)') + (mb.extra ? ' *' : ''), s: S.left },
      { v: dup.has(mb.name) ? mb.last4 : '', s: S.center },
    ];
    let total = 0;
    dates.forEach((d, k) => {
      const present = !!getRecord(d, mb.id);
      if (present) total++;
      row[FIRST + k] = off.has(d) && !present ? { v: '', s: S.off } : { v: present ? '○' : '', s: S.mark };
    });
    row[totalCol] = { v: total, s: S.total };
    rows.push(row);
  });

  const sum = [{ v: '', s: S.header }, { v: '출석 인원', s: S.header }, { v: '', s: S.header }];
  dates.forEach((d, k) => {
    sum[FIRST + k] = { v: members.filter((mb) => getRecord(d, mb.id)).length, s: S.total };
  });
  sum[totalCol] = { v: '', s: S.header };
  rows.push(sum);

  if (members.some((x) => x.extra)) rows.push([], [{ v: '* 표시: 명단에 없어 출석 체크 화면에서 추가된 분', s: S.info }]);
  if (!dates.length) rows.push([], [{ v: '※ 수업 요일이 설정되지 않았습니다. 관리 > 프로그램에서 요일을 선택하면 날짜 칸이 만들어집니다.', s: S.info }]);

  const heights = [];
  heights[0] = 28;
  heights[3] = 32;
  return {
    name: program,
    rows,
    merges,
    heights,
    cols: [5, 11, 6, ...dates.map(() => 4.5), 6],
    freeze: [FIRST, 4],
    print: true,
    printTitleRows: 4,
  };
}

/** 출석부 엑셀 Blob. 숨김 시트에 이 기기의 전체 기록이 백업으로 함께 들어간다. */
export function buildBook(programs, startMonth, months) {
  const sheets = programs.map((p) => programSheet(p, startMonth, months));
  sheets.push(backupSheet(exportData()));
  return writeXlsx(sheets);
}

/** 담당자용 빈 명단 양식 */
export function rosterTemplate() {
  return writeXlsx([
    {
      name: '명단',
      rows: [
        [{ v: '이름', s: S.header }, { v: '전화번호', s: S.header }, { v: '프로그램명', s: S.header }],
        [{ v: '홍길동', s: S.left }, { v: '010-0000-1234', s: S.left }, { v: '노래교실', s: S.left }],
        [{ v: '김영희', s: S.left }, { v: '010-0000-5678', s: S.left }, { v: '줌바댄스', s: S.left }],
        [],
        [{ v: '※ 예시 두 줄은 지우고 입력하세요. 한 분이 여러 프로그램을 들으면 프로그램마다 한 줄씩 적습니다.', s: S.info }],
        [{ v: '※ 생년월일·금액·결제 칸이 있어도 괜찮습니다. 출석부는 이름·전화번호·프로그램명만 읽습니다.', s: S.info }],
      ],
      cols: [14, 18, 18],
    },
  ]);
}

/** 수업 하나의 현재 명단 (명단 양식과 같은 모양) */
export function rosterSheet(program) {
  const members = membersOf(program);
  const dup = duplicateNames(members);
  return writeXlsx([
    {
      name: program,
      rows: [
        ['번호', '이름', '전화번호 뒷자리', '프로그램명', '비고'].map((v) => ({ v, s: S.header })),
        ...members.map((m, i) => [
          { v: i + 1, s: S.center },
          { v: m.name, s: S.left },
          { v: m.last4, s: S.center },
          { v: program, s: S.left },
          { v: [m.extra && '명단 외 추가', dup.has(m.name) && '동명이인'].filter(Boolean).join(', '), s: S.left },
        ]),
      ],
      cols: [6, 14, 16, 18, 18],
      freeze: [0, 1],
    },
  ]);
}

export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
