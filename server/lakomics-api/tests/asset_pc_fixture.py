"""Isolated HTTP fixture for the Rust/real-server lifecycle and materialization gate.
No production settings, tokens, databases or R2 endpoints are used.
"""
import hashlib, os, sys, tempfile
from pathlib import Path
from tests.test_capture_api_stub import fake_s3
import app as api
import asset_authority, authority, api_auth, classification_authority
from capture_store import StoredMedia
from fastapi import Response
from fastapi.testclient import TestClient
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

root=Path(os.environ['LAKOMICS_ASSET_FIXTURE_ROOT'])
api.DB_PATH=root/'server.sqlite'
# Each run must observe the fixture's own from-scratch server, so a reused root cannot
# carry the previous run's promoted Capture / activated domain into the next one.
for stale in (api.DB_PATH, Path(str(api.DB_PATH)+'-wal'), Path(str(api.DB_PATH)+'-shm')):
    stale.unlink(missing_ok=True)
api.API_TOKEN='asset-fixture-client'
for start in (api.startup,api.startup_replication,api.startup_captures,authority.startup,api_auth.startup,classification_authority.startup):
    if start in (authority.startup,api_auth.startup,classification_authority.startup): start(api.get_db)
    else: start()
api.startup_asset_authority()
library='e'*32
with api.get_db() as db:
    db.execute("INSERT INTO authority_domains(library_id,domain,epoch,contract_version,change_cursor,baseline_digest,activated_at) VALUES(?,'classifications',1,1,0,'fixture','2026-09-19T00:00:00Z')",[library])
    db.execute("INSERT INTO classification_authority_state(library_id,classification_id,name,kind,entity_revision,deleted,created_at,updated_at) VALUES(?,'a','A','root',1,0,'2026-09-19T00:00:00Z','2026-09-19T00:00:00Z')",[library])
    db.execute("INSERT INTO api_clients(id,token_hash,role,label,created_at) VALUES('fixture-client',?,'client','fixture',?)",[api_auth.token_hash('asset-fixture-client'),api.now_iso()])
    _,publisher=api_auth.provision_token(db,'publisher','fixture')
    asset_authority.activate(db,library_id=library,now=api.now_iso())
    db.commit()
(root/'publisher.txt').write_text(publisher)
# The fixture generates its own decodable media: PC ingestion decodes images, so a
# caller-supplied file that is not a real PNG fails later as an unrelated
# `UnsupportedImage` in the middle of the lifecycle gate.
def _png():
    import struct, zlib
    def chunk(kind, data):
        body=kind+data
        return struct.pack('>I',len(data))+body+struct.pack('>I',zlib.crc32(body)&0xffffffff)
    raw=b''.join(b'\x00'+bytes([10,20,30])*4 for _ in range(4))
    return (b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',4,4,8,2,0,0,0))
            +chunk(b'IDAT',zlib.compress(raw))+chunk(b'IEND',b''))
media=(root/'media.png').read_bytes() if (root/'media.png').exists() else _png()
api.fetch_media_to_r2=lambda *args: StoredMedia('image/png',len(media),hashlib.sha256(media).hexdigest())
port=int(os.environ['LAKOMICS_ASSET_FIXTURE_PORT'])
api.presign_get=lambda *args:f'http://127.0.0.1:{port}/_fixture/media'
api._s3.head_object=lambda **kwargs:{'ContentType':'image/png','ContentLength':len(media)}
api.create_capture(api.CaptureCreate(source_url='https://x.com/example/status/1/photo/1',media_url='https://pbs.twimg.com/media/test.png',classification_id='a'),authorization='Bearer asset-fixture-client')
@api.app.get('/_fixture/media')
def fixture_media():return Response(media,media_type='image/png')
@api.app.post('/_fixture/prune')
def fixture_prune():
    with api.get_db() as db:
        cursor=authority.active_domain(db,'assets')['cursor']
        db.execute('DELETE FROM asset_authority_changes')
        db.execute('INSERT OR REPLACE INTO asset_authority_retention VALUES(?,1,?,?)',[library,cursor,api.now_iso()]);db.commit()
    return {'ok':True}
(root/'ready').write_text('ready')
client=TestClient(api.app)
class Bridge(BaseHTTPRequestHandler):
    def dispatch(self):
        body=self.rfile.read(int(self.headers.get('Content-Length','0')))
        response=client.request(self.command,self.path,headers=dict(self.headers),content=body)
        self.send_response(response.status_code)
        self.send_header('Content-Type',response.headers.get('content-type','application/json'))
        self.send_header('Content-Length',str(len(response.content)))
        self.end_headers();self.wfile.write(response.content)
    do_GET=dispatch;do_POST=dispatch;do_PUT=dispatch
    def log_message(self,*args):pass
ThreadingHTTPServer(('127.0.0.1',port),Bridge).serve_forever()
