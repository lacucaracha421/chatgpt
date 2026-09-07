package com.lakomics.mobile;
import java.util.*;

public final class PickerSnapshotTest {
    private static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    private static PickerSnapshot.Media row(String id,String mime,long date,String... albums){return new PickerSnapshot.Media(id,mime,date,100,0,0,0,new HashSet<>(Arrays.asList(albums)),0);}
    private static Map<String,PickerSnapshot.Media> rows(PickerSnapshot.Media... rows){Map<String,PickerSnapshot.Media> result=new HashMap<>();for(PickerSnapshot.Media m:rows)result.put(m.id,m);return result;}
    public static void main(String[] args){
        Map<String,String> names=new HashMap<>();names.put("class:a","Root / A");names.put("class:b","Root / B");
        PickerSnapshot empty=PickerSnapshot.empty();
        PickerSnapshot first=empty.merge(rows(row("1","image/png",5,"class:a"),row("2","video/mp4",10,"class:b"),row("3","image/jpeg",10,"class:a")),names,100);
        check(first.collection.equals(empty.collection)&&first.generation==1,"Stable collection and first generation");
        check(first.select(null,-1,null,0).get(0).id.equals("3"),"Deterministic newest-first tie order");
        check(first.select("class:a",-1,new String[]{"image/*"},100).size()==2,"Album and MIME and inclusive size");
        check(first.select("class:a",-1,new String[]{"video/*"},0).isEmpty(),"Album must not leak unrelated media");
        check(first.select(null,-1,null,99).isEmpty(),"Size bound enforced");
        check(first.select(null,1,null,0).isEmpty(),"Generation delta exclusive");
        PickerSnapshot unchanged=first.merge(first.media,names,200);
        check(unchanged.generation==1&&unchanged.syncedAt==200,"No false generation from refresh time");
        PickerSnapshot next=first.merge(rows(row("1","image/png",5,"class:b"),row("3","image/jpeg",10,"class:a")),names,300);
        check(next.generation==2&&next.select(null,1,null,0).size()==1,"Membership change is a delta");
        check(next.deleted.get("2")==2&&first.deleted.isEmpty(),"Deletion retained and old snapshot immutable");
        PickerSnapshot later=next.merge(next.media,names,400);check(later.deleted.containsKey("2"),"Tombstone survives later snapshots");
        PickerSnapshot restored=later.merge(first.media,names,500);check(!restored.deleted.containsKey("2")&&restored.media.get("2").generation==3,"Restored row supersedes tombstone");
        Map<String,String> parents=new HashMap<>(),labels=new HashMap<>();parents.put("child","root");labels.put("root","Root");labels.put("child","Child");
        check(PickerSnapshot.breadcrumb("child",parents,labels).equals("Root / Child"),"Nested classification breadcrumb");parents.put("root","child");check(PickerSnapshot.breadcrumb("child",parents,labels).equals("Root / Child"),"Hierarchy cycle bounded");
        check(PickerSnapshot.offset("version:500","version")==500,"Continuation offset");
        for(String token:new String[]{"old:500","version:-1","version:999999","version:garbage"}){boolean failed=false;try{PickerSnapshot.offset(token,"version");}catch(IllegalArgumentException e){failed=true;}check(failed,"Reject stale or malformed continuation");}
        System.out.println("PickerSnapshotTest passed: ordering, selection, generation, deletion, restoration, hierarchy and pagination");
    }
}
