# Lakomics AV Provider and High-Resolution Artwork Enrichment Plan

**Date:** 2026-09-08  
**Target project:** Lakomics  
**Intended repository path:** `docs/research/av-provider-artwork-enrichment-plan-20260908.md`

## 1. Goal

Extend the existing Lakomics AV Collection feature with:

- external title lookup by product code,
- metadata preview and selective import,
- high-resolution artwork discovery,
- full-jacket artwork handling,
- optional sample-image browsing,
- provenance-aware local artwork storage.

The target user flow is:

`Enter product code -> Search -> Confirm work -> Compare metadata -> Review artwork candidates -> Apply selected fields and images`

The current AV Collection implementation already supports manual AV metadata, people/role relations, local front/spine/back artwork, and focused cover viewing. This plan is a follow-up provider and artwork-enrichment layer on top of that implementation.

## 2. Product Principles

### 2.1 User-triggered lookup

External network access begins only when the user explicitly requests a lookup or artwork search.

The first version should not:
- crawl the entire AV library,
- periodically refresh every title,
- run a bulk artwork backfill,
- continuously poll providers.

This keeps provider traffic low and makes failures easy to understand.

### 2.2 Preview before apply

External data must not write directly into a Collection.

The flow should be:

1. search,
2. choose a result,
3. fetch details,
4. compare local and external values,
5. select fields,
6. apply.

Manual edits must remain authoritative until the user explicitly chooses to replace them.

### 2.3 Separate metadata providers from artwork sources

Do not treat a single site as the source of truth for everything.

Use two layers:

- **AV Provider**: work identity and metadata.- **Artwork Resolver**: cover, jacket, and sample-image discovery.

The first metadata provider should be **AVBase**.

High-resolution artwork should be enriched from multiple sources when available.

---

## 3. Phase A — AVBase Metadata Provider

### 3.1 Search input

Typical input:

`JUR-517`

Normalize:

- trim whitespace,
- normalize case,
- normalize hyphen variants,
- preserve the original visible product code,
- rank exact normalized product-code matches first.

AVBase can aggregate multiple storefront variants for a single work. Search should therefore identify the AVBase work first and avoid treating every storefront product as a separate Lakomics work.

### 3.2 Data extraction

Prefer the structured JSON embedded in the page's Next.js `__NEXT_DATA__` payload.Observed AVBase data includes fields such as:

- work ID / product code,
- title,
- minimum/release date,
- actors/cast,
- genres,
- maker,
- label,
- series,
- description,
- runtime/volume,
- product image URL,
- thumbnail URL,
- large sample-image URLs.

Older integrations also use Next.js `_next/data/<buildId>/...json` routes, but Lakomics should avoid making the build ID the primary contract because it is more fragile.

### 3.3 Preview model

Introduce an AV-specific preview DTO similar to existing provider preview/apply flows:

```text
AvImportPreview
- provider
- externalId
- productCode
- title
- originalTitle
- releaseDate- runtimeMinutes
- maker
- label
- series
- director
- performers[]
- genres[]
- description
- artworkCandidates[]
- sampleImageCandidates[]
- providerSnapshot
```

### 3.4 External binding

After the user applies an AVBase result, persist an external binding using the existing Collection external-binding system:

```text
provider = "avbase"
external_id = stable AVBase work identity
provider_data_json = last applied provider snapshot
last_synced_at = timestamp
```

Do not create a separate provider ownership table if the current external-binding model can represent the relationship safely.

---

## 4. Phase B — Artwork Candidate ResolverDo not automatically accept the first image returned by AVBase.

Normalize every discovered candidate into a common structure:

```text
ArtworkCandidate
- source
- sourceWorkId
- url
- role
- width
- height
- byteSize
- aspectRatio
- fullJacket
- frontOnly
- confidence
- provenance
```

Before ranking, perform bounded validation:

- final URL after redirects,
- MIME type,
- byte size,
- image dimensions,
- aspect ratio,
- decode validity.

Do not infer quality from a filename such as `pl.jpg` alone.
---

## 5. High-Resolution Artwork Sources

### 5.1 FANZA / DMM

**Primary source for full-jacket artwork when available.**

Useful data exposed by current integrations includes:

- package-image medium and large variants,
- large sample images,
- product metadata,
- storefront identity.

DMM/FANZA jacket resolution varies substantially by title. Therefore:

- inspect actual image dimensions,
- do not assume every `pl.jpg` is high resolution,
- classify horizontal jacket images separately from vertical front covers.

Recommended uses:

- full jacket,
- source for front/back/spine extraction,
- sample gallery,
- fallback front cover.

### 5.2 MGS
**Strong official-source fallback for covers and samples.**

Current MGS page structure exposes:

- an enlarged cover link,
- larger image URL variants,
- sample photos,
- title metadata.

Recommended uses:

- enlarged front/full cover,
- fallback when FANZA artwork is missing or too small,
- MGS-first titles,
- sample-image gallery.

### 5.3 Amazon Japan

**Preferred source for high-resolution vertical front covers when an exact match is possible.**

Amazon often offers substantially larger vertical package images than storefront jacket thumbnails.

Search confidence must be strict.

Recommended identity order:

1. exact known ASIN,
2. product code + performer,
3. product code + title,4. title + performer.

Reject or require manual confirmation when the product code does not match.

Recommended uses:

- Collection grid cover,
- focused front-cover viewing,
- highest-quality vertical front artwork.

Do not classify a normal Amazon vertical cover as a full jacket.

### 5.4 Tenhow

**Useful artwork and Amazon-discovery fallback.**

Potential uses:

- high-resolution front-cover candidate,
- ASIN discovery,
- bridge to Amazon Japan,
- secondary title/product-code verification.

Treat it as an enrichment source rather than the primary metadata authority.

### 5.5 XCITY

**Optional/manual fallback, especially for older titles.**

XCITY remains useful as a catalog/reference source, but the first Lakomics implementation should avoid depending on old undocumented image-path assumptions.
Suggested first-stage support:

- manual external URL,
- "Open external source" action,
- experimental resolver behind a feature flag if later validated.

---

## 6. Artwork Role Policy

### 6.1 Front cover

Default ranking preference:

1. exact-match Amazon JP high-resolution front,
2. MGS enlarged front,
3. Tenhow high-resolution front,
4. FANZA/DMM front,
5. AVBase default product image.

The final score should also consider:

- exact product match,
- pixel dimensions,
- aspect ratio,
- decode quality,
- source reliability.

### 6.2 Full jacket
Default ranking preference:

1. FANZA/DMM large full jacket,
2. MGS full/enlarged jacket,
3. AVBase product variant,
4. manual URL/file.

A vertical cover should not be silently classified as a full jacket.

### 6.3 Spine and back

Do not permanently auto-crop spine/back in the first version.

Instead provide:

`Create front / spine / back from this jacket`

This opens a crop editor where the user confirms the three regions.

The resulting images are stored through the existing local artwork pipeline as:

- `cover`
- `spine`
- `back`

Keep provenance linking the derived images to the original full-jacket source.

---## 7. Artwork Ranking

Avoid exposing a mysterious numeric score to the user.

Internally, candidate ranking can use:

```text
resolution score
+ source reliability
+ exact product-code confidence
+ target-role aspect match
+ full-jacket/front classification confidence
- tiny-image penalty
- suspicious upscale penalty
- unexpected-aspect penalty
- identity mismatch penalty
```

User-visible cards should show plain facts:

```text
Amazon JP
1524 x 2168
Front cover
Recommended
```

```text
FANZA
2184 x 1468Full jacket
Recommended
```

The user should always be able to choose a lower-ranked image manually.

---

## 8. Import UI

Add an `Import info` action to the AV Collection detail/editor.

### 8.1 Search

```text
Product code
[JUR-517                    ] [Search]
```

### 8.2 Result selection

Show:

- product code,
- title,
- release date,
- performers,
- maker/label,
- small preview.### 8.3 Metadata comparison

Display current and provider values side by side:

```text
Field            Current              AVBase
Title            ...                  ...
Release date     ...                  ...
Performers       ...                  ...
Maker            ...                  ...
Label            ...                  ...
Series           ...                  ...
Runtime          ...                  ...
```

Each field or field group should be independently selectable.

### 8.4 Artwork tab

Suggested tabs:

- Front
- Full jacket
- Samples
- Local file / URL

Each candidate should show:

- preview,
- source,- resolution,
- artwork role,
- confidence state.

---

## 9. Sample Image Gallery

Add an optional AV image section separate from Collection cover artwork.

Possible sources:

- FANZA large sample images,
- MGS sample photos,
- AVBase aggregated `sample_image_urls`.

Remote sample images should initially remain preview-only.

Persist only images that the user explicitly chooses with an action such as:

`Save to library`

This avoids silently copying entire remote galleries into the local library.

Cover/jacket artwork and sample-gallery media should remain different data concepts.

---

## 10. Network and Safety BoundariesPerform external requests in the Tauri/Rust layer rather than arbitrary renderer fetches.

Recommended limits:

- explicit user action,
- low concurrency,
- request timeout,
- redirect limit,
- HTML/JSON response-size limit,
- image byte limit,
- image pixel limit,
- MIME validation,
- decode validation,
- bounded result count,
- short-lived local search cache.

Provider scraping failures must be isolated from Collection CRUD.

A provider outage must never make an existing AV Collection uneditable.

---

## 11. Provider Abstraction

Use a small provider interface rather than baking AVBase logic into Collection UI code.

Suggested conceptual shape:

```text
AvProvider- search(query)
- detail(externalId)
- normalizeIdentity(value)
```

Initial implementation:

```text
AvProvider
└─ AvBaseProvider
```

Optional later provider:

```text
AvProvider
├─ AvBaseProvider
└─ JavInfoProvider
```

The artwork system should have a separate resolver interface:

```text
ArtworkResolver
├─ AvBaseArtworkResolver
├─ FanzaArtworkResolver
├─ MgsArtworkResolver
├─ AmazonJpArtworkResolver
├─ TenhowArtworkResolver
└─ ManualArtworkResolver```

This allows metadata and artwork sources to evolve independently.

---

## 12. Optional Alternative — JAVINFO

JAVINFO is worth evaluating as a later optional provider if maintaining HTML/Next.js parsing becomes costly.

A provider such as JAVINFO could offer:

- normalized title metadata,
- cast,
- maker,
- label,
- series,
- release date,
- runtime,
- full-jacket URL,
- gallery data.

Keep it optional so Lakomics does not require a paid API for the basic AV workflow.

Recommended policy:

- AVBase first,
- JAVINFO optional fallback,
- no mandatory external subscription for local AV Collections.---

## 13. Implementation Batches

### Batch 1 — AVBase lookup

Implement:

- product-code normalization,
- AVBase search parser,
- exact-match ranking,
- detail parser,
- `AvImportPreview`,
- fixture-based parser tests,
- response/time/size bounds.

Acceptance:

- several real product codes resolve correctly,
- title/date/performers/maker/label/series reach preview,
- malformed or changed responses fail cleanly.

### Batch 2 — Preview and apply

Implement:

- `Import info` UI,
- current/provider comparison,
- selective field import,
- external binding,- manual-edit preservation.

Acceptance:

- importing does not erase unrelated local fields,
- manually edited values change only when selected.

### Batch 3 — Core artwork candidates

Implement:

- AVBase product image candidates,
- FANZA/DMM candidate resolver,
- MGS candidate resolver,
- image dimension probing,
- ranking,
- artwork preview UI.

Acceptance:

- multiple artwork candidates for the same work can be compared and selected.

### Batch 4 — High-resolution enrichment

Implement:

- Amazon JP front-cover resolver,
- Tenhow front/ASIN resolver,
- optional XCITY/manual resolver,
- fallback chain.
Acceptance:

- a title with a low-resolution DMM image can discover a larger valid front cover,
- incorrect Amazon matches are not automatically selected.

### Batch 5 — Full-jacket workflow

Implement:

- full-jacket preview,
- crop editor,
- front/spine/back generation,
- provenance retention,
- apply through existing artwork storage.

Acceptance:

- one high-resolution jacket can produce user-confirmed front/spine/back surfaces,
- the original jacket can still be revisited and re-cropped.

### Batch 6 — Native acceptance

Use isolated test fixtures covering recent and older catalog entries, multiple credited people, provider-specific cases, misleading search results, VR entries, low-resolution source artwork, high-resolution full jackets, and missing artwork.
A wrong-work automatic artwork application is a release-blocking defect.

---

## 14. Recommended First Release Scope

Ship the smallest useful provider slice first:

**AVBase metadata lookup + metadata preview/apply + FANZA/DMM/MGS artwork candidate comparison**

This already changes the manual AV workflow from:

`create everything by hand`

to:

`enter product code -> import metadata -> choose the best available official artwork`

Then add:

1. Amazon JP / Tenhow high-resolution front enrichment,
2. full-jacket crop workflow,
3. optional gallery persistence,
4. optional JAVINFO fallback.

This keeps the first implementation small while leaving a clean path toward a polished high-resolution AV collection experience.

---
## 15. Research References

- AVBase: https://www.avbase.net/
- AVBase terms: https://www.avbase.net/terms
- FANZA: https://www.dmm.co.jp/digital/videoa/
- MGS: https://www.mgstage.com/
- Tenhow: https://www.tenhow.net/
- XCITY: https://xxx.xcity.jp/
- JAVINFO: https://javinfo.dev/
- MetaTube AVBase provider:
  https://github.com/metatube-community/metatube-sdk-go/tree/main/provider/avbase
- MetaTube FANZA provider:
  https://github.com/metatube-community/metatube-sdk-go/tree/main/provider/fanza
- MetaTube MGS provider:
  https://github.com/metatube-community/metatube-sdk-go/tree/main/provider/mgstage