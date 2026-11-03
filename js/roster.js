// 엑셀 명단 → {프로그램: [{name, last4}]}
// 접수 명단(이름/전화번호/프로그램명/생년월일/금액/결제)에서 이름·전화번호·프로그램명만 읽는다.
import { readXlsx, readCsv } from './xlsx.js';

export const BACKUP_SHEET = '_data';
const BACKUP_MARK = 'CHULSEOKBU-BACKUP-V1';

const clean = (v) => String(v ?? '').replace(/\s+/g, '');
const NAME_RE = /^(이름|성명|성함|회원명|이용자명|참가자명|수강생명?|대상자명?)$/;
const PHONE_RE = /(전화|연락처|핸드폰|휴대폰|휴대전화|폰번호)/;
const PROGRAM_RE = /^(프로그램명?|강좌명?|수업명?|과목명?|신청프로그램)$/;
const SKIP_NAME_RE = /^(합계|소계|총계|계|비고|이름|성명|번호|no\.?)$/i;

export async function readFile(file) {
  const buf = await file.arrayBuffer();
  if (/\.csv$/i.test(file.name)) return readCsv(buf, file.name);
  if (/\.xls$/i.test(file.name)) throw new Error('예전 엑셀 형식(.xls)입니다. 엑셀에서 "다른 이름으로 저장 → Excel 통합 문서(.xlsx)"로 저장한 뒤 다시 불러와 주세요.');
  return readXlsx(buf);
}

/** 이 앱이 내보낸 출석부 파일이면 안에 든 백업 데이터를 꺼낸다 */
export function findBackup(sheets) {
  const sh = sheets.find((s) => s.name === BACKUP_SHEET);
  if (!sh || sh.rows[0]?.[0] !== BACKUP_MARK) return null;
  const json = sh.rows.slice(1).map((r) => r[0] ?? '').join('');
  return JSON.parse(json);
}

export function backupSheet(data) {
  const json = JSON.stringify(data);
  const rows = [[BACKUP_MARK]];
  for (let i = 0; i < json.length; i += 30000) rows.push([json.slice(i, i + 30000)]);
  return { name: BACKUP_SHEET, rows, hidden: true };
}

function programFromSheetName(name) {
  return name.replace(/\s*\([^)]*\)\s*$/, '').trim() || name.trim();
}

function last4Of(phone) {
  const digits = String(phone ?? '').replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : '';
}

function findHeader(rows) {
  for (let r = 0; r < Math.min(rows.length, 20); r++) {
    const row = rows[r] || [];
    const cells = row.map(clean);
    let name = cells.findIndex((c) => NAME_RE.test(c));
    if (name < 0) name = cells.findIndex((c) => c.includes('이름') || c.includes('성명'));
    const phone = cells.findIndex((c) => PHONE_RE.test(c));
    const program = cells.findIndex((c) => PROGRAM_RE.test(c));
    if (name >= 0 || phone >= 0) {
      // 이름 칸 제목이 비어 있는 출석부 양식: 전화번호 바로 왼쪽 칸을 이름으로 본다
      if (name < 0) name = phone - 1;
      if (name < 0) continue;
      return { row: r, name, phone, program };
    }
  }
  return null;
}

/**
 * @returns {{roster: Object<string, {name:string,last4:string}[]>, notes: string[]}}
 */
export function parseRoster(sheets) {
  const roster = {};
  const notes = [];
  for (const sh of sheets) {
    if (sh.hidden || sh.name === BACKUP_SHEET) continue;
    const h = findHeader(sh.rows);
    if (!h) {
      notes.push(`'${sh.name}' 시트: 이름/전화번호 제목 칸을 찾지 못해 건너뜀`);
      continue;
    }
    let count = 0;
    let noPhone = 0;
    for (const row of sh.rows.slice(h.row + 1)) {
      let name = String(row[h.name] ?? '').trim();
      if (!name || SKIP_NAME_RE.test(clean(name)) || name.length > 20) continue;
      let last4 = h.phone >= 0 ? last4Of(row[h.phone]) : '';
      // '김미지1311' 처럼 이름 뒤에 뒷자리를 붙여 둔 경우
      const m = name.match(/^(.*?[^\d\s(])\s*\(?(\d{4})\)?$/);
      if (m) {
        name = m[1].trim();
        last4 ||= m[2];
      }
      name = name.replace(/\s+/g, ' ');
      if (!/[가-힣A-Za-z]/.test(name)) continue;
      const program = (h.program >= 0 && String(row[h.program] ?? '').trim()) || programFromSheetName(sh.name);
      const list = (roster[program] ||= []);
      if (list.some((p) => p.name === name && p.last4 === last4)) continue;
      list.push({ name, last4 });
      count++;
      if (!last4) noPhone++;
    }
    if (!count) notes.push(`'${sh.name}' 시트: 명단이 비어 있음`);
    else if (noPhone) notes.push(`'${sh.name}' 시트: ${noPhone}명은 전화번호가 없어 뒷자리 구분 불가`);
  }
  // 전화번호가 없는 동명이인은 구분할 수 없으니 알려 준다
  for (const [program, list] of Object.entries(roster)) {
    const sameNames = {};
    for (const p of list) sameNames[p.name] = (sameNames[p.name] || 0) + 1;
    for (const [n, c] of Object.entries(sameNames)) {
      if (c > 1 && list.filter((p) => p.name === n && !p.last4).length) notes.push(`${program}: 동명이인 '${n}' 중 전화번호 없는 분이 있음`);
    }
  }
  return { roster, notes };
}
