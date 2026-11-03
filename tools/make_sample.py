"""테스트용 가짜 명단 엑셀(sample/샘플_명단.xlsx)을 만든다. 실제 개인정보가 아니다."""
import random
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

random.seed(7)
SUR = list("김이박최정강조윤장임한오서신권황안송류홍")
GIVEN = ["미자", "영희", "순자", "옥순", "정숙", "영자", "말순", "춘자", "경자", "명숙",
         "철수", "영수", "만수", "광호", "상철", "꽃님", "복례", "점순", "덕자", "숙자"]
PROGRAMS = [("노래교실", 110), ("줌바댄스", 40), ("파워로빅", 30)]

rows = [["이름", "전화번호", "프로그램명", "생년월일", "금액", "결제"]]
for prog, n in PROGRAMS:
    names = set()
    for i in range(n):
        name = random.choice(SUR) + random.choice(GIVEN)
        phone = f"010-{random.randint(1000, 9999)}-{random.randint(1000, 9999)}"
        rows.append([name, phone, prog, "1950-01-01", 30000, "O"])
        names.add(name)
# 동명이인 확인용
rows.append(["김미지", "010-1111-1311", "노래교실", "", "", ""])
rows.append(["김미지", "010-2222-1322", "노래교실", "", "", ""])

shared, idx = [], {}
def s(v):
    if v not in idx:
        idx[v] = len(shared)
        shared.append(v)
    return idx[v]

def col(i):
    return chr(65 + i)

sheet = ['<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>']
for r, row in enumerate(rows, 1):
    sheet.append(f'<row r="{r}">')
    for c, v in enumerate(row):
        ref = f"{col(c)}{r}"
        if isinstance(v, int):
            sheet.append(f'<c r="{ref}"><v>{v}</v></c>')
        elif v != "":
            sheet.append(f'<c r="{ref}" t="s"><v>{s(v)}</v></c>')
    sheet.append("</row>")
sheet.append("</sheetData></worksheet>")

sst = ['<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">']
sst += [f"<si><t>{escape(v)}</t></si>" for v in shared]
sst.append("</sst>")

out = Path(__file__).resolve().parent.parent / "sample" / "샘플_명단.xlsx"
out.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>')
    z.writestr("_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
    z.writestr("xl/workbook.xml", '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="접수명단" sheetId="1" r:id="rId1"/></sheets></workbook>')
    z.writestr("xl/_rels/workbook.xml.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>')
    z.writestr("xl/worksheets/sheet1.xml", "".join(sheet))
    z.writestr("xl/sharedStrings.xml", "".join(sst))
print(out, len(rows) - 1, "rows")
