"""Loopback-only review UI and explicitly requested append jobs."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import argparse
import json
import threading
import time
from incremental import append_images, atomic_json

class Handler(SimpleHTTPRequestHandler):
    def list_directory(self, path):
        self.send_error(404)
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        super().end_headers()

    def json_response(self,value,status=200):
        body=json.dumps(value,ensure_ascii=False).encode('utf-8')
        self.send_response(status);self.send_header('Content-Type','application/json; charset=utf-8')
        self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)

    def local_request(self):
        return self.headers.get('Host')==f'127.0.0.1:{self.server.server_port}'

    def do_GET(self):
        if self.path.startswith('/api/'):
            if not self.local_request():return self.json_response({'error':'Host rejected'},403)
            if self.path=='/api/append':
                with self.server.job_lock:result=dict(self.server.job)
                return self.json_response(result)
            if self.path=='/api/checkpoint':
                checkpoint=self.server.base/'review-checkpoint.json'
                return self.json_response(json.loads(checkpoint.read_text(encoding='utf-8')) if checkpoint.exists() else None)
            return self.json_response({'error':'Not found'},404)
        super().do_GET()

    def do_POST(self):
        if not self.local_request() or self.headers.get('Origin')!=f'http://127.0.0.1:{self.server.server_port}':
            return self.json_response({'error':'Origin rejected'},403)
        if self.path not in ['/api/append','/api/checkpoint']:return self.json_response({'error':'Not found'},404)
        if self.headers.get('Content-Type','').split(';')[0]!='application/json':return self.json_response({'error':'JSON required'},415)
        try:
            length=int(self.headers.get('Content-Length','0'))
            if not 0<length<=8*1024*1024:raise ValueError('Invalid payload size')
            payload=json.loads(self.rfile.read(length))
            current=json.loads((self.server.base/'public'/'data.json').read_text(encoding='utf-8'))
            if payload['model']!=current['model'] or [x['sha256'] for x in payload['items']]!=[x['sha256'] for x in current['items']]:
                return self.json_response({'error':'다른 창에서 자료가 갱신되었습니다. 새로고침 후 다시 시도해주세요.'},409)
            records=payload['session']['state']['records']
            if len(records)!=len(current['items']) or any(r['id']!=i for i,r in enumerate(records)):raise ValueError('Invalid session')
        except (ValueError,KeyError,TypeError):return self.json_response({'error':'Invalid checkpoint'},400)
        with self.server.job_lock:
            if self.server.job['phase']=='running':return self.json_response({'error':'추가 분석이 이미 진행 중입니다.'},409)
            latest=json.loads((self.server.base/'public'/'data.json').read_text(encoding='utf-8'))
            if payload['model']!=latest['model'] or [x['sha256'] for x in payload['items']]!=[x['sha256'] for x in latest['items']]:
                return self.json_response({'error':'분석 결과가 갱신되었습니다. 새로고침 후 다시 시도해주세요.'},409)
            archive=self.server.base/'checkpoints';archive.mkdir(exist_ok=True)
            atomic_json(archive/f'{time.time_ns()}.json',payload)
            atomic_json(self.server.base/'review-checkpoint.json',payload)
            if self.path=='/api/checkpoint':return self.json_response({'saved':True})
            job_id=str(time.time_ns())
            self.server.job={'phase':'running','id':job_id,'message':'검토 기록 저장 완료. 새 파일을 확인합니다.'}
        def progress(message):
            with self.server.job_lock:self.server.job['message']=message
        def work():
            try:
                result=append_images(self.server.base,progress)
                with self.server.job_lock:self.server.job={'phase':'completed','id':job_id,'message':'완료','result':result}
            except Exception as exc:
                with self.server.job_lock:self.server.job={'phase':'failed','id':job_id,'message':str(exc)}
        threading.Thread(target=work,daemon=True).start()
        self.json_response({'id':job_id,'phase':'running'},202)

def make_server(base,port):
    server=ThreadingHTTPServer(('127.0.0.1',port),partial(Handler,directory=str(base/'public')))
    server.base=base;server.job_lock=threading.Lock();server.job={'phase':'idle'}
    return server

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--port',type=int,default=1439)
    args=parser.parse_args()
    server=make_server(Path(__file__).resolve().parent,args.port)
    print(f'Character review: http://127.0.0.1:{args.port}',flush=True)
    server.serve_forever()
