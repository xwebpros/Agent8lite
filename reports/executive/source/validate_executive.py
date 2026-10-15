from pathlib import Path
import json,re,hashlib
from zipfile import ZipFile
from lxml import etree
import pymupdf

root=Path(__file__).resolve().parents[1]
manifest=json.loads((root/'document-manifest.json').read_text(encoding='utf-8'))
pdf=pymupdf.open(root/manifest['deliverables'][1])
all_text='\n'.join(p.get_text() for p in pdf)
normalized_text=re.sub(r'-\s+','-',all_text)
ids=re.findall(r'MOD-[A-K]-\d{3}',normalized_text)
checks={
    'expected20Pages':len(pdf)==20,
    'all76Requirements':set(ids)==set(manifest['requirementIds']) and len(ids)==76,
    'all19SectionsOnIntendedPages':all(manifest['pageTitles'][n] in pdf[n].get_text().replace('\n',' ').replace('  ',' ') for n in range(1,20)),
    'pdfBookmarks':len(pdf.get_toc())>=19,
    'noReplacementGlyphs':'\ufffd' not in all_text,
}
docx=root/manifest['deliverables'][0]
ns={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main','wp':'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing'}
with ZipFile(docx) as z:
    styles=etree.fromstring(z.read('word/styles.xml'))
    body=etree.fromstring(z.read('word/document.xml'))
    checks['noParagraphBorders']=not styles.xpath('//w:pBdr',namespaces=ns) and not body.xpath('//w:pBdr',namespaces=ns)
    pictures=body.xpath('//wp:docPr',namespaces=ns)
    checks['nineVisualsWithAltText']=len(pictures)==9 and all(p.get('descr') for p in pictures)
    tables=body.xpath('//w:tbl',namespaces=ns)
    checks['allTableHeadersMarked']=all(t.xpath('./w:tr[1]/w:trPr/w:tblHeader',namespaces=ns) for t in tables)
report={'pageCount':len(pdf),'functionalRequirements':len(ids),'checks':checks,'files':[],'renderer':'Microsoft Word PDF export and PyMuPDF PNG rendering','visualReview':'Pending final page inspection'}
for name in manifest['deliverables']:
    path=root/name
    report['files'].append({'file':name,'bytes':path.stat().st_size,'sha256':hashlib.sha256(path.read_bytes()).hexdigest()})
(root/'validation.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
print(json.dumps(report,indent=2))
if not all(checks.values()):raise SystemExit('Document validation failed')
