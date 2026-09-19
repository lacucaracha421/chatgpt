"""Reproducible isolated 10k-Asset query/plan measurement; never production data."""
import hashlib, json, sqlite3, statistics, time
import asset_authority, asset_visibility, authority, classification_authority, album_authority

LIBRARY='e'*32

def run():
    db=sqlite3.connect(':memory:');db.row_factory=sqlite3.Row
    db.executescript('''CREATE TABLE assets(id TEXT PRIMARY KEY,kind TEXT,object_key TEXT,content_type TEXT,size_bytes INTEGER,sha256 TEXT,collected_at TEXT,created_at TEXT,updated_at TEXT,committed INTEGER);
CREATE INDEX idx_assets_mobile_sort ON assets(committed,COALESCE(collected_at,created_at) DESC,id DESC);
CREATE TABLE pc_asset_authority_state(asset_id TEXT PRIMARY KEY,lifecycle TEXT,materialization TEXT,projection TEXT);
CREATE INDEX asset_materialization_candidates ON pc_asset_authority_state(materialization,lifecycle,asset_id);
CREATE TABLE pc_asset_lifecycle_outbox(asset_id TEXT,desired TEXT,sequence INTEGER);
CREATE INDEX asset_lifecycle_outbox_by_asset ON pc_asset_lifecycle_outbox(asset_id,sequence);''')
    db.executescript(authority.AUTHORITY_DDL+asset_authority.DDL+classification_authority.DDL+album_authority.DDL)
    for domain in ('assets','classifications','albums'):
        db.execute("INSERT INTO authority_domains(library_id,domain,epoch,contract_version,change_cursor,baseline_digest,activated_at) VALUES(?,?,1,1,1000,'fixture','2026')",[LIBRARY,domain])
    assets=[];states=[];pc=[];assignments=[];members=[];changes=[]
    for i in range(10000):
        ident=f'asset-{i:05d}';sha=hashlib.sha256(ident.encode()).hexdigest();stamp=f'2026-09-{i%28+1:02d}T00:00:00Z';life='tombstoned' if i%100==0 else 'trash' if i%20==0 else 'normal'
        assets.append((ident,'image','fixture/'+ident,'image/png',1000,sha,stamp,stamp,stamp,1))
        states.append((LIBRARY,ident,life,1,'image','fixture/'+ident,'image/png',1000,sha,stamp,stamp))
        pc.append((ident,life,'pending' if i%3==0 else 'complete','{}'))
        if i<9000:assignments.append((LIBRARY,ident,f'class-{i%100:03d}',1,stamp,stamp))
        for j in range(i%4):members.append((LIBRARY,f'album-{(i+j)%100:03d}',ident,1,1,stamp,stamp))
        if i<1000:changes.append((LIBRARY,1,i+1,'trashAsset',ident,2,ident,'{}',stamp))
    db.executemany('INSERT INTO assets VALUES(?,?,?,?,?,?,?,?,?,?)',assets)
    db.executemany('INSERT INTO asset_authority_state(library_id,asset_id,lifecycle,entity_revision,kind,object_key,content_type,size_bytes,sha256,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',states)
    db.executemany('INSERT INTO pc_asset_authority_state VALUES(?,?,?,?)',pc)
    db.executemany('INSERT INTO classification_authority_assignments VALUES(?,?,?,?,?,?)',assignments)
    db.executemany('INSERT INTO album_authority_members VALUES(?,?,?,?,?,?,?)',members)
    db.executemany('INSERT INTO asset_authority_changes VALUES(?,?,?,?,?,?,?,?,?)',changes)
    asset_visibility.install(db);db.execute('ANALYZE')
    queries={
      'asset list':('SELECT * FROM visible_assets a WHERE committed=1 ORDER BY COALESCE(collected_at,created_at) DESC,id DESC LIMIT 41',[]),
      'classification filter':('SELECT * FROM visible_assets a WHERE committed=1 AND EXISTS(SELECT 1 FROM classification_authority_assignments c WHERE c.library_id=? AND c.asset_id=a.id AND c.classification_id=?) ORDER BY COALESCE(collected_at,created_at) DESC,id DESC LIMIT 41',[LIBRARY,'class-021']),
      'Album media':('SELECT a.* FROM album_authority_members m JOIN visible_assets a ON a.id=m.asset_id WHERE m.library_id=? AND m.album_id=? AND m.desired_state=1 AND a.committed=1 ORDER BY COALESCE(a.collected_at,a.created_at) DESC,a.id DESC LIMIT 41',[LIBRARY,'album-021']),
      'baseline':('SELECT * FROM asset_authority_state WHERE library_id=? AND asset_id>? ORDER BY asset_id LIMIT 500',[LIBRARY,'asset-04000']),
      'change feed':('SELECT * FROM asset_authority_changes WHERE library_id=? AND epoch=? AND sequence>? AND (? IS NULL OR sequence<=?) ORDER BY sequence LIMIT 200',[LIBRARY,1,200,1000,1000]),
      'materialization candidate':("SELECT projection FROM pc_asset_authority_state s WHERE materialization='pending' AND lifecycle='normal' AND NOT EXISTS(SELECT 1 FROM pc_asset_lifecycle_outbox o WHERE o.asset_id=s.asset_id AND o.desired<>'normal') ORDER BY asset_id LIMIT 25",[]),
      'lifecycle lookup':('SELECT lifecycle,entity_revision FROM asset_authority_state WHERE library_id=? AND asset_id=?',[LIBRARY,'asset-09999'])}
    output={'assets':len(assets),'assignments':len(assignments),'memberships':len(members),'runs':50,'queries':{}}
    for name,(sql,params) in queries.items():
        values=[]
        for _ in range(50):
            start=time.perf_counter();rows=db.execute(sql,params).fetchall();values.append((time.perf_counter()-start)*1000)
        output['queries'][name]={'rows':len(rows),'median_ms':round(statistics.median(values),3),'p95_ms':round(sorted(values)[47],3),'plan':[r[3] for r in db.execute('EXPLAIN QUERY PLAN '+sql,params)]}
    return output
if __name__=='__main__':print(json.dumps(run(),indent=2))
