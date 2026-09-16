package com.lakomics.mobile;

import java.util.Arrays;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Additive Album collection projection.
 *
 * These checks pin the 2C-2 domain boundary rather than the Album protocol: Classification
 * collections and `album:` collections are independent namespaces that coexist, only live
 * Album/membership state is published, and an unadopted scope contributes nothing at all —
 * which is what makes the change additive for every existing Classification consumer.
 */
public final class AlbumCollectionsTest {
    private static int checks = 0;

    private static void check(boolean value, String message) {
        if (!value) throw new AssertionError(message);
        checks++;
    }

    private static Map<String, AlbumReplica.Album> albums(AlbumReplica.Album... rows) {
        Map<String, AlbumReplica.Album> map = new LinkedHashMap<>();
        for (AlbumReplica.Album row : rows) map.put(row.id, row);
        return map;
    }

    private static Map<String, AlbumReplica.Member> members(AlbumReplica.Member... rows) {
        Map<String, AlbumReplica.Member> map = new LinkedHashMap<>();
        for (AlbumReplica.Member row : rows) map.put(row.albumId + ":" + row.assetId, row);
        return map;
    }

    private static AlbumReplica.Album album(String id, String name, String parent, boolean deleted) {
        return new AlbumReplica.Album(id, name, parent, null, null, deleted, 1);
    }

    private static PickerSnapshot.Media asset(String id, String... collections) {
        return new PickerSnapshot.Media(id, "image/png", 1, 100, 0, 0, 0,
                new HashSet<>(Arrays.asList(collections)), 0);
    }

    private static Map<String, PickerSnapshot.Media> assets(PickerSnapshot.Media... rows) {
        Map<String, PickerSnapshot.Media> map = new LinkedHashMap<>();
        for (PickerSnapshot.Media row : rows) map.put(row.id, row);
        return map;
    }

    public static void main(String[] args) {
        unadoptedScopeContributesNothing();
        classificationAndAlbumNamespacesCoexist();
        onlyLiveAlbumStateIsPublished();
        albumMembershipIsAdditiveAndOrdered();
        membershipToADeletedAlbumIsNotPublished();
        System.out.println("AlbumCollectionsTest passed: " + checks
                + " checks (additive namespace, live-only publication, tombstone hiding)");
    }

    /** The property that makes the change safe: nothing is published when nothing is adopted. */
    private static void unadoptedScopeContributesNothing() {
        AlbumCollections empty = AlbumCollections.empty();
        check(empty.names.isEmpty(), "An unadopted scope publishes no Album collections");
        check(empty.byAsset.isEmpty(), "An unadopted scope publishes no Album membership");
        Map<String, PickerSnapshot.Media> rows = assets(asset("a", "class:c1"));
        check(empty.merge(rows).get("a").albums.size() == 1,
                "Merging nothing leaves existing Classification membership exactly as it was");
        check(AlbumCollections.build(albums(), members()).names.isEmpty(),
                "No Album rows means no Album collections");
    }

    /** The two domains name different things and must both survive in one consumer. */
    private static void classificationAndAlbumNamespacesCoexist() {
        AlbumCollections built = AlbumCollections.build(
                albums(album("root", "업로드용", null, false)),
                members(new AlbumReplica.Member("root", "a", true, 1)));
        check(built.names.keySet().equals(new HashSet<>(Arrays.asList("album:root"))),
                "Album collections use the album: namespace");
        check(built.names.get("album:root").equals("업로드용"), "Album collection name is the Album name");
        PickerSnapshot.Media merged = built.merge(assets(asset("a", "class:c1"))).get("a");
        check(merged.albums.equals(new HashSet<>(Arrays.asList("class:c1", "album:root"))),
                "An Asset carries both its Classifications and its Albums");
        check(AlbumCollections.PREFIX.equals("album:"), "The Album prefix no longer collides with class:");
    }

    /** Revision state the replica retains for replay is not state a consumer may show. */
    private static void onlyLiveAlbumStateIsPublished() {
        AlbumCollections built = AlbumCollections.build(
                albums(album("live", "Live", null, false), album("gone", "Gone", null, true)),
                members(new AlbumReplica.Member("live", "a", true, 2),
                        new AlbumReplica.Member("live", "b", false, 3)));
        check(built.names.containsKey("album:live"), "A live Album is published");
        check(!built.names.containsKey("album:gone"), "A deleted Album is hidden");
        check(built.byAsset.containsKey("a"), "A desiredState=true relation is published");
        check(!built.byAsset.containsKey("b"), "A desiredState=false tombstone is hidden");
    }

    private static void albumMembershipIsAdditiveAndOrdered() {
        AlbumCollections built = AlbumCollections.build(
                albums(album("z", "Z", null, false), album("a", "A", null, false)),
                members(new AlbumReplica.Member("z", "x", true, 1),
                        new AlbumReplica.Member("a", "x", true, 1),
                        new AlbumReplica.Member("z", "x", true, 1)));
        List<String> list = built.byAsset.get("x");
        check(list.equals(Arrays.asList("album:a", "album:z")), "Membership is deduplicated and ordered");
        check(built.names.keySet().toString().equals("[album:a, album:z]"),
                "Album collections are ordered by id for a deterministic publication");
    }

    /** An Album tombstone removes the Album, so a surviving relation must not publish it. */
    private static void membershipToADeletedAlbumIsNotPublished() {
        AlbumCollections built = AlbumCollections.build(
                albums(album("gone", "Gone", null, true)),
                members(new AlbumReplica.Member("gone", "a", true, 1)));
        check(built.byAsset.isEmpty(), "A live relation to a deleted Album publishes no membership");
        check(built.merge(assets(asset("a"))).get("a").albums.isEmpty(),
                "That Asset carries no album: membership");
    }
}
