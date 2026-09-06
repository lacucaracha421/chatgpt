"""Read-only album snapshot provisioning for the personal-device PoC. No source media or library writes."""
import ctypes,ctypes.wintypes as w,sqlite3,urllib.request,json,subprocess,hashlib,datetime,time,argparse
from pathlib import Path
parser=argparse.ArgumentParser();parser.add_argument('--library',required=True);parser.add_argument('--serial',required=True);parser.add_argument('--album',action='append',required=True,help='ID=display name');args=parser.parse_args()
class Cred(ctypes.Structure):
 _fields_=[('Flags',w.DWORD),('Type',w.DWORD),('TargetName',w.LPWSTR),('Comment',w.LPWSTR),('LastWritten',w.FILETIME),('CredentialBlobSize',w.DWORD),('CredentialBlob',ctypes.POINTER(ctypes.c_ubyte)),('Persist',w.DWORD),('AttributeCount',w.DWORD),('Attributes',ctypes.c_void_p),('TargetAlias',w.LPWSTR),('UserName',w.LPWSTR)]
p=ctypes.POINTER(Cred)();a=ctypes.windll.advapi32
if not a.CredReadW('Lakomics/CloudApi',1,0,ctypes.byref(p)):raise RuntimeError('Cloud credential unavailable')
token=ctypes.string_at(p.contents.CredentialBlob,p.contents.CredentialBlobSize).decode();a.CredFree(p)
c=sqlite3.connect(Path(args.library).resolve().as_uri()+'?mode=ro',uri=True);c.row_factory=sqlite3.Row
base=c.execute('select cloud_api_base_url from library_settings').fetchone()[0].rstrip('/')
import ipaddress,urllib.parse
u=urllib.parse.urlsplit(base)
if u.scheme != 'https' and not (u.scheme == 'http' and ipaddress.ip_address(u.hostname) in ipaddress.ip_network('100.64.0.0/10')):raise RuntimeError('HTTPS or existing Tailscale endpoint required')
albums=[];media={}
for spec in args.album:
 aid,name=spec.split('=',1)
 if not c.execute('select 1 from albums where id=?',(aid,)).fetchone():raise RuntimeError('Album not found')
 albums.append({'id':aid,'name':name})
 for row in c.execute("select x.*,coalesce(v.duration_ms,0) duration from asset_albums aa join assets x on x.id=aa.asset_id left join video_assets v on v.asset_id=x.id where aa.album_id=? and x.status='normal' order by x.collected_at desc",(aid,)):
  item=media.setdefault(row['id'],{'id':row['id'],'date':int(datetime.datetime.fromisoformat(row['collected_at'].replace('Z','+00:00')).timestamp()*1000),'width':row['width'] or 0,'height':row['height'] or 0,'duration':row['duration'],'albums':[]})
  item['albums'].append(aid)
ids=list(media)
for offset in range(0,len(ids),25):
 r=urllib.request.Request(base+'/v1/library/media-tickets',data=json.dumps({'items':[{'asset_id':i,'variant':v} for i in ids[offset:offset+25] for v in ['original','thumbnail']]}).encode(),headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
 data=json.load(urllib.request.urlopen(r,timeout=40))
 for item in data['items']:
  if not item['ok']:raise RuntimeError('Cloud variant unavailable for '+item['asset_id']+' '+item['variant'])
  if item['variant']=='original':media[item['asset_id']].update(mime=item['content_type'],size=item['size_bytes'])
manifest={'albums':albums,'media':list(media.values())}
revision=hashlib.sha256(json.dumps(manifest,sort_keys=True).encode()).hexdigest()[:24]
manifest.update(revision=revision,generation=int(time.time()),base=base,token=token)
adb=str(Path(__file__).resolve().parents[1]/'platform-tools/adb.exe');prefix=[adb,'-s',args.serial]
subprocess.run(prefix+['shell','run-as','com.lakomics.cloudpoc','mkdir','-p','files'],check=True,capture_output=True)
# Secret travels on stdin directly into the app sandbox; never logged or saved on PC/shared storage.
subprocess.run(prefix+['shell','run-as','com.lakomics.cloudpoc','sh','-c',"'umask 077; cat > files/connection.new; mv files/connection.new files/connection.json'"],input=json.dumps(manifest,ensure_ascii=False).encode(),check=True,capture_output=True)
print(json.dumps({'albums':len(albums),'media':len(media),'revision':revision}))
