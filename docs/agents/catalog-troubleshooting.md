# Lakomics catalog troubleshooting

## CATALOG-003 — Independent Korean/Japanese ingestion

Implementation verification: 105 Rust catalog regressions passed (the real-data
benchmark and real-source canary remain opt-in/ignored), 33 server API tests
passed, and 270 frontend tests across 15 affected/regression files passed.
TypeScript checking, production build, scoped formatting/whitespace checks, and
`git diff --check` passed. The operational gate subsequently passed as recorded
below; the active catalog was not mutated.

### Verified operational result

The authorized single-file deployment used `server/lakomics-api/app.py` from
commit `8d644c40ed88ab1ba6ec00ead23ae04eeff35768`. The production file at
`/home/linuxuser/lakomics-api/app.py` matched SHA-256
`609fa6aa92af308d447e96a5d68dd21ff8fa96783e8ac76e8d739d1b6fcaa226`.
`lakomics-api.service` remained active/running with `NRestarts=0`. Health, legacy
and explicit Korean search, Japanese search and cursor composition, and gallery
requests succeeded; language acknowledgements were correct, invalid language
returned 400, and missing authentication returned 401. This retry needed no
rollback. The retained pre-deployment rollback file remains available.

The earlier deployment failure came from PowerShell's final CRLF on piped SSH
input: Bash received `fi\r`, leaving the `if` block unterminated after file
replacement. The retry used individual transfer, hash, atomic replacement,
restart, and status commands, each with its own checked exit code.

The unchanged `japanese_real_source_two_page_canary` test passed once: exactly
two Japanese pages, 100 committed works. Representative IDs were 4169846,
4169813, and 4160148, below the read-only source's global/Korean maximum 4169932.
The Japanese checkpoint moved from watermark 0 / no cursor / pending maximum 0
to watermark 0 / cursor 4160148 / pending maximum 4169846; initial completion
correctly remained false. Reopening resumed from Japanese state, and replaying
each page left data/checkpoint counts unchanged. The frozen Korean checkpoint
remained watermark 4169932 / no cursor; preexisting importer state was unchanged.

A read-only audit of the disposable result additionally verified Japanese tags,
both language memberships on 16 real Korean-overlapping works (including
4167777 and 4166996), and post-canary `PRAGMA quick_check = ok`. The test's backup
quick-check also passed. Temporary audit links retained the disposable files
only until inspection; those links and the test's temporary files were removed.
The source `C:\New_lakomics_assets\catalogs\kdata.db` was opened read-only and its
SHA-256 before and after was
`9a3d7462a95af35a002cfa03bf49a5e0275601c8a6e06f6f483365c7f8f0834f`.
No broad Japanese crawl or active-catalog ingestion was performed. CATALOG-003's
implementation/operational gate is complete; this is not a claim that a full
Japanese initial crawl has completed.

The existing `catalogs/kdata.db` remains the canonical catalog. No table, index,
or user-metadata migration is required. `CrawlState(Key, Value)` stores JSON under
`lakomics.catalog.kHentai.{korean|japanese}.checkpoint` and `.status`.
The checkpoint contains `watermark`, `cursor`, `pending_max`, and
`initial_complete`. Status independently records attempt, committed progress,
completed-pass timestamps, added-row count, and the last error.

Korean adopts an existing paired `lakomics_update_watermark` / `lakomics_update_cursor`
without deleting those legacy keys. With no legacy checkpoint, its baseline is
the maximum ID tagged `language:korean`. This baseline is frozen before Japanese
ingestion writes data. Unrelated importer state such as `sweep.*` is untouched.
Japanese starts at watermark zero regardless of any existing work IDs.

Every valid Japanese initial-page work is upserted, including IDs below the
Korean maximum. One SQLite transaction writes canonical `Works`, returned `Tags`,
the next checkpoint, and committed-progress status. Any failure rolls back the
whole page. The cursor descends independently; the initial watermark stays zero
until the end, when it becomes the highest ID observed across committed pages.
Later passes retain that watermark while interrupted and ingest IDs above it.
Checkpoint comparison rejects stale advancement; replaying an already committed
page does not repeat its writes or increment its added count.

For an overlapping canonical ID, the latest successful response owns remote
metadata and non-language tags. Existing Korean/Japanese language memberships are
unioned with returned tags, including writes from targeted recovery. Other works,
bookmarks, reading progress, and visibility preferences are untouched.

The authenticated VPS endpoint accepts
`GET /v1/catalog/search-page?language=japanese&cursor=<positive signed-64-bit ID>`.
Only `korean` and `japanese` are accepted; omitted language retains Korean
compatibility, and the cursor is optional. Upstream URL translation remains on
the VPS. Responses acknowledge the chosen language in
`X-Lakomics-Catalog-Language`. The desktop requires the Japanese acknowledgement
and Japanese tags before committing a Japanese page, preventing an old VPS from
silently supplying Korean results. Japanese has no Korean WebView fallback.

Settings shows each stream's checkpoint, pending cursor, last committed progress,
completion, and error separately. Japanese initial start/resume fetches one page
per manual action. Runs are capped at 40 pages, and automatic Japanese incremental
updates are eligible only after initial completion. Korean remains the default
browsing scope. The Japanese checkpoint reset deletes only its two namespaced
state keys; it does not delete works, tags, Korean state, or user metadata.

### Bounded real-source canary (deployment gate)

Implementation and fixture tests alone do **not** prove real-source ingestion.
The deployment and bounded canary gate has now passed as recorded above.
Future production deployments still require authorization; no broad initial
Japanese crawl is authorized by this procedure.

After the VPS supports the acknowledgement header, set these process environment
variables through the local credential/session mechanism without logging secrets:

- `LAKOMICS_JAPANESE_CANARY_SOURCE`: explicitly selected existing `kdata.db` path.
- `LAKOMICS_JAPANESE_CANARY_VPS`: deployed authenticated VPS base URL.
- `LAKOMICS_JAPANESE_CANARY_TOKEN`: Bearer token; never paste it into reports.

From the repository root, run only the bounded ignored test:

```powershell
cargo test --manifest-path app/src-tauri/Cargo.toml --lib japanese_real_source_two_page_canary -- --ignored --nocapture --test-threads=1
```

It opens the source read-only, creates a SQLite online backup, verifies
`PRAGMA quick_check`, and mutates only a disposable copy of that known backup.
It fetches at most two Japanese pages, reopens the checkpoint between pages,
checks metadata/language tags, confirms Korean state is unchanged, and replays
each page to verify idempotence. It must observe an ID below the preexisting
global maximum. If the two-page sample does not contain one, the gate stays
unproven; a source that ends on page one also leaves the resume gate unproven.
Do not automatically extend the crawl. The temporary backup and working
copy are cleaned up at test exit; this does not constitute a durable operational
backup. Before separately approved ingestion into the active catalog, create and
verify a retained SQLite backup and record its location.

The checkpoint/status change does not alter search SQL or add indexes. Existing
CATALOG-004 Boolean compilation, visibility predicates, count/page parity, and
the Latest-sort performance fix remain covered by the catalog regression suite.
Read-only `EXPLAIN QUERY PLAN` on the existing catalog with either language scope
and no visibility restrictions still uses `IdxWorksRank` as a covering COUNT
index and `IdxWorksPosted` for the Latest page, with a primary-key lookup on
`Tags(WorkId, Namespace, Value)` for language membership. The page retains only
the existing final-order-term temporary sort; no checkpoint table participates
in either query.

## CATALOG-001 — k-hentai gallery 451 / Lakomics 502

### Symptom

- `GET /v1/catalog/search-page` succeeds.
- `GET /v1/catalog/gallery/{id}` returns `502 Bad Gateway` from Lakomics.
- Upstream response from `https://k-hentai.org/r/{id}` is actually `451 Unavailable For Legal Reasons`.
- The 451 body is a normal K-Hentai page, not a FastAPI/Tailscale-generated error.

### Important diagnostic result

The failure was **not** caused by the gallery id, login state, cookies, Japan VPS routing, Referer, HTTP/2, or curl vs urllib by themselves.

Observed on the Tokyo VPS:

```text
curl / urllib with non-browser style request          -> 451
browser Copy-as-cURL                                  -> 200
Copy-as-cURL with cookies removed                     -> 200
browser UA only                                       -> 451
browser navigation headers without Accept-Language   -> 451
browser UA + Accept-Language                          -> 200
browser UA + Accept-Language, default curl protocol   -> 200
Python urllib + browser UA + Accept-Language          -> 200
```

The minimal tested successful request properties were:

```text
User-Agent: browser-like Chrome/Edge UA
Accept-Language: ko,en;q=0.9,en-US;q=0.8,ko-KR;q=0.7
```

`--http1.1` is **not** required. An earlier `curl --http1.1 -> 200` result was a misleading intermediate observation; later tests showed HTTP version was not the determining condition.

### Fix

Keep the catalog transport on `urllib.request.urlopen` and send browser-like request headers.

Representative configuration:

```python
CATALOG_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/152.0.0.0 Safari/537.36 Edg/152.0.0.0"
)

CATALOG_ACCEPT_LANGUAGE = "ko,en;q=0.9,en-US;q=0.8,ko-KR;q=0.7"
```

Request headers:

```python
{
    "User-Agent": CATALOG_UA,
    "Accept-Language": CATALOG_ACCEPT_LANGUAGE,
    "Accept": "text/html,application/json;q=0.9,*/*;q=0.8",
}
```

Preserve the existing retry/backoff/cache/body-size/auth/SSRF behavior and upstream-status diagnostics.

### Verification

After deployment to the Tokyo VPS, the following were confirmed:

```text
/health                                -> 200
/v1/catalog/gallery/4157357            -> 200
/v1/catalog/search-page                -> 200
```

Direct Python verification on the VPS also returned:

```text
urllib + browser UA + Accept-Language -> STATUS: 200
```

### Future debugging rule

If gallery requests regress to `502`, inspect the FastAPI response `detail` first. Do not immediately assume Tailscale, VPS geography, HTTP/2, or login/cookie restrictions.

For k-hentai `/r/{id}`, first verify that the outgoing request still has both the browser-like `User-Agent` and `Accept-Language` header. A missing or non-browser-style header set can be surfaced by upstream as HTTP 451.
