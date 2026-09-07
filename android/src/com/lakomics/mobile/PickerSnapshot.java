package com.lakomics.mobile;

import java.util.*;

/** Immutable, Android-independent replica and delta rules. */
final class PickerSnapshot {
    static final int MAX_ITEMS = 200000;
    static final class Media {
        final String id, mime;
        final long date, size, duration, generation;
        final int width, height;
        final Set<String> albums;
        Media(String id, String mime, long date, long size, long duration, int width, int height, Set<String> albums, long generation) {
            this.id=id; this.mime=mime; this.date=date; this.size=size; this.duration=duration;
            this.width=width; this.height=height; this.albums=Collections.unmodifiableSet(new TreeSet<>(albums)); this.generation=generation;
        }
        Media generation(long value) { return new Media(id,mime,date,size,duration,width,height,albums,value); }
        boolean same(Media m) { return m!=null && mime.equals(m.mime) && date==m.date && size==m.size && duration==m.duration && width==m.width && height==m.height && albums.equals(m.albums); }
    }
    final String collection;
    final long generation, syncedAt;
    final Map<String,Media> media;
    final Map<String,Long> deleted;
    final Map<String,String> albums;
    PickerSnapshot(String collection,long generation,long syncedAt,Map<String,Media> media,Map<String,Long> deleted,Map<String,String> albums) {
        this.collection=collection; this.generation=generation; this.syncedAt=syncedAt;
        this.media=Collections.unmodifiableMap(new TreeMap<>(media)); this.deleted=Collections.unmodifiableMap(new TreeMap<>(deleted)); this.albums=Collections.unmodifiableMap(new TreeMap<>(albums));
    }
    static PickerSnapshot empty() { return new PickerSnapshot(UUID.randomUUID().toString(),0,0,Collections.emptyMap(),Collections.emptyMap(),Collections.emptyMap()); }
    PickerSnapshot merge(Map<String,Media> incoming,Map<String,String> names,long now) {
        long next=generation+1; boolean changed=!albums.equals(names);
        Map<String,Media> rows=new TreeMap<>(); Map<String,Long> tombstones=new TreeMap<>(deleted);
        for(Media m:incoming.values()) { Media old=media.get(m.id); boolean same=m.same(old); rows.put(m.id,m.generation(same?old.generation:next)); changed|=!same; tombstones.remove(m.id); }
        for(String id:media.keySet()) if(!incoming.containsKey(id)){tombstones.put(id,next);changed=true;}
        // Never discard tombstones under a stable collection ID. Rotate only when history reaches its bound.
        if(tombstones.size()>MAX_ITEMS) { Map<String,Media> fresh=new TreeMap<>(); for(Media m:rows.values())fresh.put(m.id,m.generation(1)); return new PickerSnapshot(UUID.randomUUID().toString(),1,now,fresh,Collections.emptyMap(),names); }
        return new PickerSnapshot(collection,changed?next:generation,now,rows,tombstones,names);
    }
    List<Media> select(String album,long after,String[] mimes,long maxSize) {
        List<Media> result=new ArrayList<>();
        for(Media m:media.values()) if(m.generation>after && (album==null||m.albums.contains(album)) && (maxSize<=0||m.size<=maxSize) && matches(m.mime,mimes))result.add(m);
        result.sort(Comparator.comparingLong((Media m)->m.date).reversed().thenComparing(m->m.id,Comparator.reverseOrder())); return result;
    }
    static boolean matches(String mime,String[] filters) { if(filters==null||filters.length==0)return true; for(String f:filters)if(f!=null&&(f.equals("*/*")||f.equalsIgnoreCase(mime)||(f.endsWith("/*")&&mime.startsWith(f.substring(0,f.length()-1)))))return true;return false; }
    static int offset(String token,String version) { if(token==null)return 0; String prefix=version+":";if(!token.startsWith(prefix))throw new IllegalArgumentException("Snapshot changed; restart query");try{int n=Integer.parseInt(token.substring(prefix.length()));if(n<0||n>MAX_ITEMS)throw new NumberFormatException();return n;}catch(NumberFormatException e){throw new IllegalArgumentException("Invalid page token");} }
    static String breadcrumb(String id,Map<String,String> parents,Map<String,String> names) {
        LinkedList<String> path=new LinkedList<>();Set<String> visited=new HashSet<>();String current=id;
        while(current!=null&&names.containsKey(current)&&visited.add(current)){path.addFirst(names.get(current));current=parents.get(current);}
        return String.join(" / ",path);
    }
}
