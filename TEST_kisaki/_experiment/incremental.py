"""Append-only local inference. Existing IDs, images, and cached evidence survive."""
import copy
import json
import time
import hashlib
from pathlib import Path
import numpy as np
import onnxruntime as ort
from PIL import Image
import analyze

HERE = Path(__file__).resolve().parent

def atomic_json(path, value):
    tmp = path.with_suffix(path.suffix + '.tmp')
    tmp.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')
    tmp.replace(path)

def _append_images(base=HERE, progress=lambda message: None):
    started=time.perf_counter()
    public=base/'public'
    path=public/'data.json'
    old=json.loads(path.read_text(encoding='utf-8'))
    source=base.parent
    files=sorted([p for folder in [source, source/'man'] for p in folder.iterdir() if p.is_file()],key=lambda p:str(p))
    hashes={str(p):analyze.sha(p) for p in files}
    existing={x['sha256'] for x in old['items']}
    known=set(existing)
    additions=[]
    skipped=[]
    for p in files:
        if p.suffix.lower() not in analyze.EXT:
            skipped.append({'name':p.name,'reason':'unsupported type'})
        elif hashes[str(p)] not in known:
            additions.append(p);known.add(hashes[str(p)])
    present=set(hashes.values())
    result={'added':0,'newIds':[],'scanned':len(files),'existing':len(old['items']),
            'missingRetained':sum(x['sha256'] not in present for x in old['items']),
            'skipped':skipped,'sourcesUnchanged':True}
    if not additions:
        progress('새로운 이미지가 없습니다. 기존 검토 기록을 유지합니다.')
        return result
    progress(f'새 이미지 {len(additions)}장 분석 준비')
    manifest=json.loads((base/'models'/'manifest.json').read_text())
    if manifest != old['model']:
        raise RuntimeError('Model changed; cannot combine feature spaces.')
    for name,digest in manifest['sha256'].items():
        if analyze.sha(base/'models'/name)!=digest:raise RuntimeError('Model hash mismatch')
    identity=hashlib.sha256(json.dumps(manifest,sort_keys=True).encode()).hexdigest()[:16]
    def cache(h):return base/'cache'/f'{identity}-{h}.npy'
    features=[]
    for x in old['items']:
        if not cache(x['sha256']).exists():raise RuntimeError('Existing feature cache missing; original evidence was not discarded.')
        features.append(np.load(cache(x['sha256']),allow_pickle=False))
    options=ort.SessionOptions();options.intra_op_num_threads=4;options.inter_op_num_threads=1
    model=None
    mean=np.array([.48145466,.4578275,.40821073],dtype=np.float32)[:,None,None]
    std=np.array([.26862954,.26130258,.27577711],dtype=np.float32)[:,None,None]
    data=copy.deepcopy(old)
    for n,p in enumerate(additions,1):
        h=hashes[str(p)]
        try:im=analyze.rgb(p)
        except Exception as exc:
            skipped.append({'name':p.name,'reason':str(exc)});continue
        if cache(h).exists():feat=np.load(cache(h),allow_pickle=False)
        else:
            if model is None:model=ort.InferenceSession(str(base/'models'/'model_feat.onnx'),sess_options=options,providers=['CPUExecutionProvider'])
            arr=np.asarray(im.resize((384,384),Image.Resampling.BILINEAR),dtype=np.float32).transpose(2,0,1)/255
            feat=model.run(['output'],{'input':((arr-mean)/std)[None].astype(np.float32)})[0][0]
            np.save(cache(h),feat)
        if not np.isfinite(feat).all():raise RuntimeError('Invalid feature')
        small=np.asarray(im.resize((9,8)).convert('L'))
        dhash=sum(int(x)<<i for i,x in enumerate((small[:,1:]>small[:,:-1]).flatten()))
        item={'id':len(data['items']),'name':p.name,'path':str(p.relative_to(source)),'positive':p.parent.name=='man',
              'sha256':h,'dhash':str(dhash),'width':im.width,'height':im.height,'thumbnail':f'thumbs/{h}.jpg'}
        im.thumbnail((420,420));im.save(public/item['thumbnail'],quality=87)
        data['items'].append(item);features.append(feat);result['newIds'].append(item['id'])
        progress(f'새 이미지 {n}/{len(additions)}장 처리')
    if not result['newIds']:return result
    metric=ort.InferenceSession(str(base/'models'/'model_metrics.onnx'),sess_options=options,providers=['CPUExecutionProvider'])
    matrix=metric.run(['output'],{'input':np.stack(features).astype(np.float32)})[0]
    if matrix.shape!=(len(features),len(features)) or not np.isfinite(matrix).all():raise RuntimeError('Invalid metric output')
    data['distances']=np.round(matrix,7).tolist()
    # Keep old duplicate groups; connect only newly arrived images to existing/new ones.
    groups=list(range(len(data['items'])))
    def root(i):
        while groups[i]!=i:i=groups[i]
        return i
    for x in old['items']:groups[root(x['id'])]=root(x['duplicateGroup'])
    pairs=list(old.get('duplicatePairs',[]))
    for i in result['newIds']:
        a=data['items'][i]
        for j in range(i):
            b=data['items'][j]
            if a['sha256']==b['sha256'] or ((int(a['dhash'])^int(b['dhash'])).bit_count()<=4 and abs(a['width']/a['height']-b['width']/b['height'])<.05):
                groups[root(i)]=root(j);pairs.append([i,j])
    for item in data['items']:item['duplicateGroup']=root(item['id'])
    if any(analyze.sha(Path(p))!=h for p,h in hashes.items()):raise RuntimeError('Input changed during analysis; results not published.')
    result.update(added=len(result['newIds']),seconds=round(time.perf_counter()-started,2))
    data['duplicatePairs']=pairs;data['latestAppend']=result
    data['sourcesUnchanged']=True
    if 'initialReports' not in data:data['initialReports']=data.get('reports',[])
    data['reports']=[]
    archive=base/'archive'/f'append-{time.time_ns()}'
    archive.mkdir(parents=True)
    atomic_json(archive/'previous-data.json',old)
    atomic_json(archive/'scanned-hashes.json',hashes)
    atomic_json(path,data)
    atomic_json(base/'append-report.json',result)
    progress(f'추가 분석 완료: {result["added"]}장')
    return result

def append_images(base=HERE, progress=lambda message: None):
    lock=base/'.append.lock'
    try:
        guard=lock.open('x')
    except FileExistsError:
        raise RuntimeError('An append job is already running or needs recovery; existing data was retained.')
    try:
        with guard:return _append_images(base,progress)
    finally:
        lock.unlink()

if __name__=='__main__':
    print(json.dumps(append_images(progress=lambda s:print(s,flush=True)),ensure_ascii=False))
