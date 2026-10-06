# Collections authority 1B batch 5 contract (AV)

This implementation is dormant until separately approved authority activation. It
does not activate a library, deploy a server, migrate production data, or add AV
authority commands.

## Reading stays

- PC: the replica apply keeps AV works readable. Work entities carry `details.av`
  (product code, Japanese title, maker, label, series, genres, release date) and
  `avCredits` (`personId`, `name`, `nameJa`, `role`, `order`, `portraitCrop`); the
  apply upserts `collection_av_details`, `collection_people` (display name, Japanese
  name) and replaces the work's `collection_person_relations`. Person-local data
  (memo, Wikidata/FANZA identifiers, portraits and crops, StashDB profiles,
  favorites) and the local `collection_av_details.revision` are never deleted by
  the baseline or the feed. Because a credit's `name` is the person's display name,
  the apply keeps the local per-work credit name for an existing
  `(person, role)` and stores none for a new credit; previously every credit
  received its display name as a duplicated credit name.
- Tablet: unchanged. After activation `/v1/collections` and
  `/v1/collections/{id}` serve `av.people[]` (with `portraitImage`) from the
  authority projection, and `/v1/collections/people/{personId}` serves the staged
  `collection_authority_people` payload. The existing activation test compares
  these responses before and after activation.
- No server change: the feed still has no people section. That is sufficient
  while people editing is fenced, because the PC's local people are the staged
  baseline values. A people section arrives with the AV follow-up that adds AV
  commands; a PC replica built on a fresh database would lack portraits, profiles
  and memos until then.

## Fenced while active

Each returns `collection_authority_operation_unavailable` with
"서버 이전 후 다음 단계에서 다시 지원합니다." before any network request or file read,
and again inside the writing transaction:

- AV detail save (product code, label, series, people and credits).
- AV artwork apply (front/spine/back).
- AV link apply (creating an AV Collection, people and credits); the inbox item
  stays `found` so it can be applied after the follow-up.
- Person memo; portrait crop, clear, Commons preview/use, StashDB photo preview/use.
- StashDB explicit refresh, candidate search, choose, dismiss and clear.
- AV favorite add/remove.

Automatic paths stay quiet: opening a performer page refreshes the StashDB
profile with `force=false`, which returns the stored profile without contacting
StashDB or reporting an error. AV inbox polling, candidate fetching, the name cache
and poll state write only PC-local `av_link_*` tables and keep running. The
performer page shows the fence message for an explicit StashDB refresh or choice
instead of its generic failure text.

## Writer guard

The seven batch 5 file-wide exemptions are removed. Named fenced functions
(`save_av_details`, `apply_av_artwork`, `apply_people`, `apply_av_link`,
`save_av_person_memo`, the four portrait writers, StashDB `save` and
`clear_av_performer_profile`, `set_av_favorite`) must keep their fence call, and a
new writer elsewhere in those files fails the scan. The AV inbox remains a
local-only exemption.

## Acceptance limits

Rust library tests, the server unit suite and the collections frontend tests ran
in this environment. No app launch, device check, production-library access or
real-server request is part of this batch.
