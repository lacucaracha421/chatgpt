# Cloud-first ingest + PC reconciliation proposal

Status: **design proposal / research note only**  
Date: 2026-09-07

This document records a possible future direction for Lakomics after the PC application was frozen for the Linux transition. It is **not** an implementation decision, deployment authorization, or instruction to modify production data. The current behavior remains unchanged unless a later task explicitly adopts part of this proposal.

## Why this proposal exists

Current remote collection works, but a newly saved cloud capture does not become a normal Mobile library asset until the desktop Lakomics application runs and imports it.

The current path is effectively:

```text
Browser extension
  -> VPS Capture Inbox
  -> desktop Lakomics downloads the pending capture
  -> desktop ingest_media() decides identity / duplicate / classification
  -> desktop outbound cloud replication
  -> VPS/R2 committed Cloud Library asset
  -> Lakomics Mobile / Android providers
```

This is safe because the desktop library is authoritative, but it creates an awkward `VPS -> PC -> VPS` round trip. When the PC is off for a long time, new captures remain pending instead of appearing immediately in the normal Mobile library.

## Current architecture constraints

The existing implementation intentionally separates two flows:

- **Cloud Capture Inbox:** remote collection transport from browser/remote device toward the desktop library.
- **Cloud Library replication:** committed desktop library assets replicated from PC to VPS/R2 for Mobile consumption.

The desktop inbound consumer currently downloads each pending capture and calls the normal `ingest_media()` path. That path owns important decisions such as exact duplicate handling, near-duplicate review, local asset creation, classification validation, provenance, and local storage. Only after local ingestion does the normal cloud replication path publish the resulting asset.

The Mobile client, DocumentsProvider, and CloudMediaProvider intentionally read the committed Cloud Library rather than treating pending Capture Inbox rows as canonical assets.

## Target experience

The desired long-term user experience is:

```text
Save image/video in browser
  -> VPS receives it
  -> it becomes a committed Cloud Library asset
  -> Mobile sees it immediately

PC may be offline for hours or days.
When PC returns, it reconciles the missing cloud-created assets into the local library.
```

The PC should remain the main management workstation for bulk organization, editing, recovery, and destructive operations, but it should no longer need to be the gate that every remote save must pass through before Mobile can see it.

## Recommended conceptual architecture

The cleanest direction is to add a **server-side promotion** step between Capture and the committed Cloud Library.

```text
Browser
  -> Cloud ingest
      -> validate source/media
      -> fetch original to R2
      -> compute exact hash
      -> detect exact duplicate
      -> create or reuse stable asset_id
      -> attach classification/provenance
      -> generate thumbnail/poster
      -> atomically commit Cloud Library asset
          -> Mobile immediately sees asset
          -> PC later reconciles asset locally
```

The existing Capture Inbox does not need to disappear. Instead, it can become a fallback/review queue:

```text
normal unambiguous capture
  -> promote directly to committed asset

ambiguous / unsupported / validation failure / review-required
  -> remain in Capture Inbox
```

This keeps the simple daily path fast while preserving a safe place for cases that should not be auto-promoted.

## Authority model

The largest architectural change is not media transfer; it is **authority**.

Today:

```text
PC library = canonical
VPS/R2 = rebuildable read-oriented replica
```

A cloud-first ingest path means some assets are first created in the cloud. The safest interpretation is not to make the server the owner of all Lakomics state, but to split responsibility more carefully:

```text
VPS/R2
  = always-available ingest endpoint
  = Mobile-visible committed media state
  = stable asset identity for cloud-created assets

Desktop Lakomics
  = long-term local copy
  = library management / classification editing
  = bulk operations / recovery / destructive actions
  = reconciliation participant
```

Stable identity must survive movement between these sides.

## Stable asset identity

A cloud-created asset must not receive one ID on the server and a second ID when the PC later downloads it.

Recommended rule:

- every committed asset has one global `asset_id` (UUID or equivalent stable opaque ID);
- cloud-created assets keep that ID when imported into the desktop library;
- desktop-created assets already replicated to the cloud keep their existing ID;
- reconciliation must be idempotent.

Without this rule, duplicate records, broken classification relationships, deletion ambiguity, and sync loops become likely.

## Exact duplicate handling

Server-side promotion should support **exact duplicate detection**, but should stay conservative beyond that.

Recommended behavior:

1. hash the incoming original;
2. if an existing committed asset has the same authoritative hash, reuse the existing `asset_id`;
3. apply the requested classification/provenance update according to explicit merge rules;
4. do not create a second identical asset.

Example:

```text
existing asset SHA-256 = ABC
new browser save SHA-256 = ABC

=> reuse existing asset
=> optionally add/update requested classification
```

Because the full library is already replicated, the server can potentially maintain enough committed metadata to perform exact-hash lookup without consulting the PC.

## Near-duplicate handling

Different hashes may still represent effectively the same image because of resizing, recompression, cropping, watermarking, or edits.

This is where server-side automation should remain conservative.

Recommended first version:

- exact duplicate: automatic;
- clearly new asset: automatic;
- near-duplicate suspicion: do **not** silently merge;
- optionally mark for later review or let the desktop reconciliation path surface it.

Do not reproduce the entire desktop similarity/review engine on the VPS merely to remove PC uptime from the normal save path.

## Thumbnail and video poster generation

A committed Mobile asset needs a usable thumbnail.

For images, the VPS can generate a bounded WebP/JPEG thumbnail after validating the original. For video, it needs a bounded poster-frame extraction path such as FFmpeg.

Operational concerns:

- CPU and memory limits on the VPS;
- video decode cost;
- corrupt or adversarial media;
- timeouts and maximum bytes/dimensions/duration;
- concurrency limits;
- temporary file cleanup;
- a failure must not leave a half-committed Mobile asset.

Promotion should therefore use an atomic state transition: the asset becomes visible only after the original and required thumbnail/poster are confirmed ready.

## Classification state

The extension may save while the PC is offline, using the last known classification snapshot.

That snapshot can be stale. Server promotion should therefore validate the supplied `classification_id` against the server's current published classification snapshot.

Safe behavior:

- known active ID -> attach it;
- unknown/stale ID -> do not invent a replacement;
- store the asset as unclassified/review-required or keep it in Capture Inbox, depending on the adopted product rule.

Classification names must never be used as identity; IDs remain authoritative.

## PC reconciliation

Cloud-first ingest requires a formal **Cloud -> PC reconciliation** path rather than relying on the old pending Capture importer.

The PC should be able to ask:

```text
Which committed cloud assets do I not have locally?
```

For each missing asset it should receive enough information to recreate the local canonical record safely:

- stable asset_id;
- original media ticket;
- authoritative hash and byte size;
- media type/MIME;
- classification IDs;
- collected/source timestamps;
- source URL and creator provenance;
- origin marker such as `cloud_ingest`;
- current cloud revision/tombstone state.

The PC downloads the media, verifies it, stores it locally, and records the **same** asset ID.

Reconciliation must be resumable and idempotent. A crash after downloading but before recording completion must not create another asset on the next run.

## Preventing synchronization loops

A major failure mode is:

```text
cloud creates asset
  -> PC downloads it
  -> PC treats it as a new local asset
  -> cloud_sync_queue uploads it again
  -> server creates another asset
  -> repeat
```

Required protections:

- stable shared `asset_id`;
- explicit origin/provenance (`cloud_ingest`, `desktop_ingest`, etc.);
- idempotent server prepare/commit semantics;
- desktop reconciliation marks an existing cloud asset as locally materialized rather than creating a new logical asset;
- exact-hash collision/duplicate rules remain deterministic.

## Server availability and fallback

Moving the normal remote-save path toward the server makes VPS/R2 availability more important.

Today, a functioning PC can still accept local ingestion when cloud services fail. A cloud-first design must preserve fallback behavior.

Recommended extension behavior:

```text
Cloud ingest succeeds
  -> normal committed asset

Cloud unavailable / timeout
  -> bounded fallback
     - direct PC ingestion if available and policy allows, or
     - device-local download/temporary save
  -> later retry remains possible
```

A browser download fallback must never be presented as proof that the Lakomics library contains the media.

## Security implications

Cloud-first promotion expands the server from a transport/replica role into a limited ingest authority. That requires stricter boundaries, not broader trust.

Keep:

- authenticated ingest endpoints;
- public-media URL validation and SSRF protections;
- bounded redirects/timeouts/bytes;
- no browser cookies forwarded to the VPS;
- no R2 credentials on clients;
- deterministic object keys or other conflict-safe object ownership;
- no permanent public media URLs;
- atomic commit only after object validation;
- no destructive delete behavior added as part of this work.

Do not make a generic arbitrary-URL fetch API.

## Main risks

### 1. Split-brain authority

PC and VPS may both create or modify state while disconnected. Identity and revision rules must prevent two logical assets for the same item and prevent stale metadata from overwriting newer decisions.

### 2. Duplicate semantics diverge

The desktop currently owns richer ingestion behavior than the server. Server promotion must not pretend exact hashing is equivalent to the desktop's full duplicate/similarity logic.

### 3. Reconciliation loops

Cloud-created items re-uploaded as new desktop items can create infinite or repeated synchronization unless identity/origin is preserved.

### 4. Stale classifications

An offline PC means the server snapshot may lag behind local classification edits. Unknown IDs need a safe holding state.

### 5. Thumbnail/video processing load

The VPS becomes responsible for enough media processing to create Mobile-ready assets. Work must be bounded and recoverable.

### 6. Server outage becomes save-path outage

Cloud-first saves depend on VPS/R2 health, so extension fallback and explicit success/failure reporting are mandatory.

### 7. Deletion becomes more complicated

Once assets can originate in the cloud, deletion/tombstone propagation becomes truly bidirectional. Do not combine global-delete redesign with the first cloud-first ingest rollout.

## Suggested staged rollout

Do not switch authority in one step.

### Stage 0 - specification only

Define:

- global asset identity rules;
- exact duplicate policy;
- classification validation behavior;
- cloud-created origin metadata;
- PC reconciliation contract;
- conflict/revision semantics.

No production changes.

### Stage 1 - isolated server promotion prototype

Use disposable fixtures only.

Prove:

- capture -> original R2 object;
- hash calculation;
- exact duplicate lookup;
- thumbnail generation;
- stable asset ID;
- atomic committed asset creation.

No desktop reconciliation yet and no production deployment.

### Stage 2 - read-only reconciliation prototype

Against fixture/local test libraries:

- list cloud-only committed assets;
- download and verify original;
- preserve server asset ID;
- prove repeated reconciliation is a no-op;
- prove no outbound re-upload loop.

### Stage 3 - mixed-origin conflict tests

Test explicitly:

- same file saved independently on PC and cloud;
- same source saved under different classifications;
- PC offline classification rename/delete;
- server promotion followed by desktop exact duplicate;
- interrupted promotion;
- interrupted PC reconciliation;
- R2 upload succeeds but DB commit fails;
- DB row exists but thumbnail generation fails.

### Stage 4 - opt-in production slice

Enable cloud-first promotion only for a narrowly scoped media class (for example X images) while retaining the existing Capture Inbox fallback.

Observe real behavior before adding video or generic-web ingestion.

### Stage 5 - broaden only after reconciliation is boring

Only after cloud-created assets repeatedly reconcile into the desktop library without duplicates, loops, or stale metadata should the default remote-save path move away from PC-gated import.

## Non-goals for the first implementation

- making the VPS the sole canonical owner of every Lakomics feature;
- moving full classification editing to Mobile;
- reproducing desktop near-duplicate review on the VPS;
- global deletion redesign;
- server-side catalog/library management parity;
- eliminating the desktop Lakomics app;
- eliminating Capture Inbox before a safe fallback/review role exists.

## Recommended direction

The most balanced long-term model is:

```text
VPS = always-available ingest + Mobile-visible committed state
R2  = durable cloud media objects
PC  = long-term local copy + management + reconciliation + recovery
```

The key change is therefore not "remove the PC". It is:

> Remove the PC from the critical path of an ordinary remote save, while preserving the PC as the main management and recovery workstation.

If adopted carefully, this turns the current `Capture -> PC -> Replication` chain into a cleaner `Capture -> Promote -> Mobile`, with the PC catching up later through an explicit, idempotent reconciliation protocol.
