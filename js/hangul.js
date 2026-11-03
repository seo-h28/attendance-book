// 한글 초성 검색 도우미
const CHO = ['ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
// 쌍자음은 예사소리로 검색되게 한다 (ㄱ으로 '꽃님'도 찾음)
const SINGLE = { 'ㄲ': 'ㄱ', 'ㄸ': 'ㄷ', 'ㅃ': 'ㅂ', 'ㅆ': 'ㅅ', 'ㅉ': 'ㅈ' };

export const KEYPAD = ['ㄱ', 'ㄴ', 'ㄷ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅅ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];

const isSyllable = (code) => code >= 0xac00 && code <= 0xd7a3;

function choOf(ch) {
  const code = ch.charCodeAt(0);
  return isSyllable(code) ? CHO[Math.floor((code - 0xac00) / 588)] : ch;
}

function charMatches(q, n, isLast) {
  if (CHO.includes(q)) {
    const c = choOf(n);
    return (SINGLE[c] || c) === (SINGLE[q] || q);
  }
  const qc = q.charCodeAt(0);
  const nc = n.charCodeAt(0);
  if (isSyllable(qc) && isSyllable(nc)) {
    if (qc === nc) return true;
    // 입력 중인 마지막 글자('기')는 받침 있는 글자('김')와도 맞춘다
    const qo = qc - 0xac00;
    const no = nc - 0xac00;
    return isLast && qo % 28 === 0 && Math.floor(qo / 28) === Math.floor(no / 28);
  }
  return q.toLowerCase() === n.toLowerCase();
}

/** 이름이 검색어(초성/글자 혼합)로 시작하는지 */
export function matchName(name, query) {
  const q = [...query.replace(/\s/g, '')];
  const n = [...name.replace(/\s/g, '')];
  if (q.length > n.length) return false;
  return q.every((c, i) => charMatches(c, n[i], i === q.length - 1));
}

export function compareKo(a, b) {
  return a.localeCompare(b, 'ko');
}
