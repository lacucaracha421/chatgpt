"""Bounded real-model check in an isolated copy, never in the input folder."""
import copy
import json
import os
import shutil
import threading
import time
import urllib.request
import urllib.error
from pathlib import Path
import hashlib
import incremental
from serve import make_server

here=Path(__file__).resolve().parent
live=json.loads((here/'public'/'data.json').read_text(encoding='utf-8'))
scratch=here/'checks'/f'append-{time.time_ns()}'
base=scratch/'_experiment'
for name in ['public/thumbs','models','cache']:(base/name).mkdir(parents=True,exist_ok=True)
(scratch/'man').mkdir()
ref=live['items'][live['referencePool'][0]]
sample=next(x for x in live['items'] if x['positive'] and x['id']!=ref['id'])
for p in (here/'models').iterdir():
    if p.is_file():os.link(p,base/'models'/p.name) # Model weights are read-only in this test.
identity=hashlib.sha256(json.dumps(live['model'],sort_keys=True).encode()).hexdigest()[:16]
filename=f'{identity}-{ref["sha256"]}.npy'
shutil.copy2(here/'cache'/filename,base/'cache'/filename)
old=copy.deepcopy(live);old['items']=[{**ref,'id':0,'duplicateGroup':0}];old['distances']=[[0.0]];old['referencePool']=[0];old['duplicatePairs']=[];old['sourceRoot']=str(scratch)
shutil.copy2(here/'public'/f'thumbs/{ref["id"]}.jpg',base/'public'/'thumbs'/'0.jpg')
incremental.atomic_json(base/'public'/'data.json',old)
shutil.copy2(here.parent/sample['path'],scratch/'man'/'new-image.webp')
first=incremental.append_images(base,print)
assert first['added']==1 and first['newIds']==[1] and first['missingRetained']==1
current=json.loads((base/'public'/'data.json').read_text(encoding='utf-8'))
assert current['items'][0]['sha256']==ref['sha256'] and current['referencePool']==[0]
assert current['items'][1]['sha256']==sample['sha256']
assert (base/'public'/current['items'][1]['thumbnail']).exists()
shutil.copy2(scratch/'man'/'new-image.webp',scratch/'renamed-copy.jpg')
second=incremental.append_images(base,print)
assert second['added']==0 and len(json.loads((base/'public'/'data.json').read_text(encoding='utf-8'))['items'])==2
server=make_server(base,0);threading.Thread(target=server.serve_forever,daemon=True).start()
origin=f'http://127.0.0.1:{server.server_port}'
payload={'items':current['items'],'model':current['model'],'session':{'state':{'records':[{'id':0},{'id':1}]},'history':[]}}
def post(body,request_origin):
    request=urllib.request.Request(origin+'/api/append',data=json.dumps(body).encode(),headers={'Content-Type':'application/json','Origin':request_origin})
    return json.load(urllib.request.urlopen(request,timeout=10))
try:
    try:post(payload,'https://example.org');raise AssertionError('Cross-origin write accepted')
    except urllib.error.HTTPError as exc:assert exc.code==403
    assert not (base/'review-checkpoint.json').exists()
    stale=copy.deepcopy(payload);stale['items'][0]['sha256']='wrong'
    try:post(stale,origin);raise AssertionError('Stale snapshot accepted')
    except urllib.error.HTTPError as exc:assert exc.code==409
    job=post(payload,origin)
    for _ in range(100):
        status=json.load(urllib.request.urlopen(origin+'/api/append',timeout=10))
        if status['phase']!='running':break
        time.sleep(.02)
    assert status['phase']=='completed' and status['result']['added']==0
    assert json.loads((base/'review-checkpoint.json').read_text(encoding='utf-8'))==payload
finally:
    server.shutdown();server.server_close()
report={'realModelAppend':first,'duplicateAndRenameNoop':second,'missingOldReferenceRetained':True,'crossOriginRejected':True,'staleCheckpointRejected':True,'checkpointSaved':True,'fixture':str(scratch)}
incremental.atomic_json(here/'incremental-verification.json',report)
print(json.dumps(report,ensure_ascii=False,indent=2))
