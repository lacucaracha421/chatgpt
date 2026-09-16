package com.lakomics.mobile;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.Set;

/**
 * The Album *collection* projection shared by the Android collectors.
 *
 * Classification and Album are separate canonical domains. The existing
 * `class:<classification-id>` collections are the Classification domain exposed through
 * Android's collection APIs, and they stay exactly as they are; this class only adds the
 * second, independent namespace.
 *
 * Two namespaces therefore coexist in one consumer, and an Asset may legitimately carry
 * both: `class:` names a folder it sits in, `album:` names an Album it was added to.
 * Neither is derived from the other, and nothing here rewrites or retires the
 * Classification side.
 *
 * Deliberately platform-free, like {@link PickerSnapshot} and {@link DocumentTreePolicy},
 * so "which Albums are visible and which Assets are in them" is checkable on the plain
 * JVM instead of only on a device.
 */
final class AlbumCollections {
    /** Prefix that keeps the two domains distinguishable inside one collection list. */
    static final String PREFIX = "album:";

    /** `album:<id>` to its breadcrumb, ordered by id so publication is deterministic. */
    final Map<String, String> names;
    /** Asset id to its live `album:<id>` memberships. Assets with none are absent. */
    final Map<String, List<String>> byAsset;

    private AlbumCollections(Map<String, String> names, Map<String, List<String>> byAsset) {
        this.names = Collections.unmodifiableMap(names);
        this.byAsset = Collections.unmodifiableMap(byAsset);
    }

    static AlbumCollections empty() {
        return new AlbumCollections(Collections.emptyMap(), Collections.emptyMap());
    }

    /**
     * Visible Albums and live memberships from replica revision state.
     *
     * Only live state is published. A tombstone is *revision state* the replica must
     * retain, not something a consumer may show, so a deleted Album contributes no
     * collection and a `desiredState=false` relation contributes no membership — even
     * though both rows stay in the database.
     *
     * Relations pointing at a deleted Album are dropped too: an Album tombstone removes
     * the Album, so a surviving live relation to it would otherwise publish a collection
     * that the Album list does not contain.
     */
    static AlbumCollections build(Map<String, AlbumReplica.Album> albums,
                                  Map<String, AlbumReplica.Member> members) {
        Map<String, String> names = new TreeMap<>();
        Map<String, String> parents = new LinkedHashMap<>();
        for (AlbumReplica.Album album : albums.values()) {
            if (album.deleted) continue;
            names.put(album.id, album.name);
            parents.put(album.id, album.parentId);
        }
        Map<String, String> labelled = new TreeMap<>();
        for (String id : names.keySet()) {
            labelled.put(PREFIX + id, PickerSnapshot.breadcrumb(id, parents, names));
        }
        Map<String, List<String>> byAsset = new TreeMap<>();
        for (AlbumReplica.Member member : members.values()) {
            if (!member.desiredState || !names.containsKey(member.albumId)) continue;
            List<String> list = byAsset.get(member.assetId);
            if (list == null) {
                list = new ArrayList<>();
                byAsset.put(member.assetId, list);
            }
            list.add(PREFIX + member.albumId);
        }
        for (List<String> list : byAsset.values()) {
            Set<String> ordered = new TreeSet<>(list);
            list.clear();
            list.addAll(ordered);
        }
        return new AlbumCollections(labelled, byAsset);
    }

    /**
     * The same Assets with their `album:` memberships added.
     *
     * The Asset rows come from the Asset projection, which is the only source of media
     * metadata; the replica supplies the relation. Intersecting here is what keeps the
     * Picker's eligibility rules authoritative: an Asset the Picker refused never reaches
     * this call, so an Album cannot make an ineligible Asset visible.
     */
    Map<String, PickerSnapshot.Media> merge(Map<String, PickerSnapshot.Media> assets) {
        if (byAsset.isEmpty()) return assets;
        Map<String, PickerSnapshot.Media> merged = new TreeMap<>();
        for (PickerSnapshot.Media media : assets.values()) {
            List<String> albums = byAsset.get(media.id);
            if (albums == null) {
                merged.put(media.id, media);
                continue;
            }
            Set<String> combined = new TreeSet<>(media.albums);
            combined.addAll(albums);
            merged.put(media.id, media.collections(combined));
        }
        return merged;
    }
}
