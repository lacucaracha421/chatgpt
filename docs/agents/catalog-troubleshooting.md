# Lakomics catalog troubleshooting

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
