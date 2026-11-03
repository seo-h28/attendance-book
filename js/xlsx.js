// 외부 라이브러리 없이 동작하는 최소한의 엑셀(.xlsx) 읽기/쓰기
// 오랫동안 손대지 않아도 되도록 CDN이나 외부 패키지에 의존하지 않는다.

/* ---------------- ZIP ---------------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(u8) {
  let c = 0xffffffff;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function inflateRaw(u8) {
  const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function unzip(buffer) {
  const u8 = new Uint8Array(buffer);
  const dv = new DataView(buffer);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('엑셀(.xlsx) 파일이 아닙니다.');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const entries = {};
  const dec = new TextDecoder();
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('손상된 파일입니다.');
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true);
    const xlen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const off = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
    const start = off + 30 + dv.getUint16(off + 26, true) + dv.getUint16(off + 28, true);
    entries[name] = { method, data: u8.subarray(start, start + csize) };
    p += 46 + nlen + xlen + clen;
  }
  return async (name) => {
    const e = entries[name];
    if (!e) return null;
    return dec.decode(e.method === 0 ? e.data : await inflateRaw(e.data));
  };
}

function zip(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const f of files) {
    const name = enc.encode(f.name);
    const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true);
    local.setUint16(8, 0, true);
    local.setUint16(10, dosTime, true);
    local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    parts.push(local, name, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x0800, true);
    c.setUint16(12, dosTime, true);
    c.setUint16(14, dosDate, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, data.length, true);
    c.setUint32(24, data.length, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    central.push(c, name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((s, x) => s + x.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

/* ---------------- 읽기 ---------------- */

function colIndex(ref) {
  let n = 0;
  for (const ch of ref) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

const byTag = (node, tag) => [...node.getElementsByTagNameNS('*', tag)];

function textOf(node) {
  // 일본어 후리가나(rPh) 같은 발음 표기는 빼고 본문 글자만 모은다
  return byTag(node, 't')
    .filter((t) => t.parentNode.localName !== 'rPh')
    .map((t) => t.textContent)
    .join('');
}

function parseSheet(doc, shared) {
  const rows = [];
  let nextRow = 0;
  for (const row of byTag(doc, 'row')) {
    const r = row.getAttribute('r') ? Number(row.getAttribute('r')) - 1 : nextRow;
    nextRow = r + 1;
    const cells = [];
    let nextCol = 0;
    for (const c of [...row.children].filter((x) => x.localName === 'c')) {
      const ref = c.getAttribute('r');
      const col = ref ? colIndex(ref) : nextCol;
      nextCol = col + 1;
      const type = c.getAttribute('t');
      const v = byTag(c, 'v')[0];
      let val = '';
      if (type === 's') val = v ? shared[Number(v.textContent)] ?? '' : '';
      else if (type === 'inlineStr') val = textOf(c);
      else if (v) val = type === 'str' || type === 'e' || type === 'b' ? v.textContent : Number(v.textContent);
      cells[col] = val;
    }
    for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = '';
    rows[r] = cells;
  }
  for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
  return rows;
}

/** @returns {Promise<{name:string, hidden:boolean, rows:any[][]}[]>} */
export async function readXlsx(buffer) {
  const read = await unzip(buffer);
  const parser = new DOMParser();
  const xml = async (path) => {
    const t = await read(path);
    return t == null ? null : parser.parseFromString(t, 'application/xml');
  };
  const shared = [];
  const ss = await xml('xl/sharedStrings.xml');
  if (ss) for (const si of byTag(ss, 'si')) shared.push(textOf(si));

  const wb = await xml('xl/workbook.xml');
  if (!wb) throw new Error('엑셀(.xlsx) 파일이 아닙니다.');
  const rels = await xml('xl/_rels/workbook.xml.rels');
  const target = {};
  for (const r of byTag(rels, 'Relationship')) target[r.getAttribute('Id')] = r.getAttribute('Target');

  const sheets = [];
  for (const s of byTag(wb, 'sheet')) {
    const rid = s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
    const t = target[rid];
    if (!t) continue;
    const path = t.startsWith('/') ? t.slice(1) : 'xl/' + t.replace(/^\.\//, '');
    const doc = await xml(path);
    if (!doc) continue;
    const state = s.getAttribute('state');
    sheets.push({ name: s.getAttribute('name'), hidden: !!state && state !== 'visible', rows: parseSheet(doc, shared) });
  }
  return sheets;
}

/** CSV도 같은 모양으로 읽는다 (UTF-8, 안 되면 EUC-KR) */
export function readCsv(buffer, name) {
  let text = new TextDecoder('utf-8').decode(buffer);
  if (text.includes('�')) text = new TextDecoder('euc-kr').decode(buffer);
  text = text.replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return [{ name: name.replace(/\.csv$/i, ''), hidden: false, rows }];
}

/* ---------------- 쓰기 ---------------- */

// 스타일 번호 (styles.xml 의 cellXfs 순서)
export const S = { title: 1, header: 2, center: 3, left: 4, off: 5, info: 6, total: 7, mark: 8 };

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="5">
<font><sz val="11"/><name val="맑은 고딕"/><family val="3"/><charset val="129"/></font>
<font><b/><sz val="16"/><name val="맑은 고딕"/><family val="3"/><charset val="129"/></font>
<font><b/><sz val="11"/><name val="맑은 고딕"/><family val="3"/><charset val="129"/></font>
<font><sz val="10"/><color rgb="FF666666"/><name val="맑은 고딕"/><family val="3"/><charset val="129"/></font>
<font><b/><sz val="12"/><color rgb="FF1E6B3A"/><name val="맑은 고딕"/><family val="3"/><charset val="129"/></font>
</fonts>
<fills count="4">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFEFF3F0"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFD9D9D9"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left style="thin"><color rgb="FF999999"/></left><right style="thin"><color rgb="FF999999"/></right><top style="thin"><color rgb="FF999999"/></top><bottom style="thin"><color rgb="FF999999"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="9">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
<xf numFmtId="0" fontId="3" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="4" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="표준" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

const esc = (s) =>
  String(s)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export function colName(i) {
  let s = '';
  for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}

function sheetXml(sh) {
  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
  out.push('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">');
  if (sh.print) out.push('<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>');
  out.push('<sheetViews><sheetView workbookViewId="0">');
  if (sh.freeze) {
    const [c, r] = sh.freeze;
    out.push(`<pane xSplit="${c}" ySplit="${r}" topLeftCell="${colName(c)}${r + 1}" activePane="bottomRight" state="frozen"/>`);
  }
  out.push('</sheetView></sheetViews><sheetFormatPr defaultRowHeight="16.5"/>');
  if (sh.cols?.length) {
    out.push('<cols>');
    sh.cols.forEach((w, i) => w && out.push(`<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`));
    out.push('</cols>');
  }
  out.push('<sheetData>');
  sh.rows.forEach((row, r) => {
    if (!row) return;
    const ht = sh.heights?.[r];
    out.push(`<row r="${r + 1}"${ht ? ` ht="${ht}" customHeight="1"` : ''}>`);
    row.forEach((cell, c) => {
      if (cell == null) return;
      const { v, s } = typeof cell === 'object' ? cell : { v: cell, s: 0 };
      const ref = colName(c) + (r + 1);
      const st = s ? ` s="${s}"` : '';
      if (v == null || v === '') out.push(`<c r="${ref}"${st}/>`);
      else if (typeof v === 'number') out.push(`<c r="${ref}"${st}><v>${v}</v></c>`);
      else out.push(`<c r="${ref}"${st} t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`);
    });
    out.push('</row>');
  });
  out.push('</sheetData>');
  if (sh.merges?.length) {
    out.push(`<mergeCells count="${sh.merges.length}">`);
    sh.merges.forEach((m) => out.push(`<mergeCell ref="${m}"/>`));
    out.push('</mergeCells>');
  }
  out.push('<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>');
  if (sh.print) out.push('<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>');
  out.push('</worksheet>');
  return out.join('');
}

function safeSheetName(name, used) {
  let base = String(name).replace(/[\[\]:*?/\\]/g, ' ').trim().slice(0, 28) || '시트';
  let n = base;
  for (let i = 2; used.has(n.toLowerCase()); i++) n = `${base}(${i})`;
  used.add(n.toLowerCase());
  return n;
}

/**
 * @param {{name:string, rows:any[][], cols?:number[], merges?:string[], heights?:number[],
 *          freeze?:[number,number], print?:boolean, printTitleRows?:number, hidden?:boolean}[]} sheets
 */
export function writeXlsx(sheets) {
  const used = new Set();
  const names = sheets.map((s) => safeSheetName(s.name, used));
  const files = [];
  files.push({
    name: '[Content_Types].xml',
    data:
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
      '</Types>',
  });
  files.push({
    name: '_rels/.rels',
    data:
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
  });
  const defined = sheets
    .map((s, i) => (s.printTitleRows ? `<definedName name="_xlnm.Print_Titles" localSheetId="${i}">'${names[i].replace(/'/g, "''")}'!$1:$${s.printTitleRows}</definedName>` : ''))
    .join('');
  files.push({
    name: 'xl/workbook.xml',
    data:
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<bookViews><workbookView/></bookViews><sheets>' +
      sheets.map((s, i) => `<sheet name="${esc(names[i])}" sheetId="${i + 1}"${s.hidden ? ' state="hidden"' : ''} r:id="rId${i + 1}"/>`).join('') +
      '</sheets>' + (defined ? `<definedNames>${defined}</definedNames>` : '') + '</workbook>',
  });
  files.push({
    name: 'xl/_rels/workbook.xml.rels',
    data:
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
      `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
  });
  files.push({ name: 'xl/styles.xml', data: STYLES });
  sheets.forEach((s, i) => files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s) }));
  return zip(files);
}
