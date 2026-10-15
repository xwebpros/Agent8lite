from pathlib import Path
import json
import pymupdf
from PIL import Image, ImageDraw, ImageFont

root=Path(__file__).resolve().parents[1]
pdf=root/'Agent8lite-Application-Requirements-and-Features-2026-10-10.pdf'
qa=root/'qa'
qa.mkdir(exist_ok=True)
doc=pymupdf.open(pdf)
pages=[]
for n,page in enumerate(doc):
    pix=page.get_pixmap(matrix=pymupdf.Matrix(1.8,1.8),alpha=False)
    pix.save(str(qa/f'page-{n+1:02d}.png'))
    words=page.get_text('words')
    text=page.get_text()
    body=[w for w in words if 38<w[1]<746]
    pages.append({'page':n+1,'words':len(body),'firstLines':text.splitlines()[:8],
                  'lastLines':text.splitlines()[-5:],'text':text,
                  'outOfBounds':[w[:5] for w in words if w[0]<24 or w[2]>590 or w[1]<10 or w[3]>783]})
thumb_w,thumb_h=340,440
for start in range(0,len(doc),6):
    contact=Image.new('RGB',(3*thumb_w,2*(thumb_h+35)), '#DDE5E8')
    draw=ImageDraw.Draw(contact)
    for j,n in enumerate(range(start,min(start+6,len(doc)))):
        im=Image.open(qa/f'page-{n+1:02d}.png')
        im.thumbnail((thumb_w-14,thumb_h-10))
        x=(j%3)*thumb_w+(thumb_w-im.width)//2
        y=(j//3)*(thumb_h+35)+28
        contact.paste(im,(x,y))
        draw.text(((j%3)*thumb_w+15,(j//3)*(thumb_h+35)+6),f'PAGE {n+1}',fill='#122A3A',font=ImageFont.truetype('C:/Windows/Fonts/seguisb.ttf',18))
    contact.save(qa/f'contact-{start+1:02d}.png')
(qa/'page-audit.json').write_text(json.dumps({'pageCount':len(doc),'pages':pages},indent=2),encoding='utf-8')
cover=Image.open(qa/'page-01.png')
cover.crop((75,135,990,300)).save(qa/'cover-title-crop.png')
print(json.dumps({'pageCount':len(doc),'pages':[{'page':p['page'],'words':p['words'],'firstLines':p['firstLines'],'outOfBounds':p['outOfBounds']} for p in pages]},indent=2))
