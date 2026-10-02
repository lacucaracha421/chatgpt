package com.lakomics.mobile;
import java.util.*;
/** Shared repository save guard; compile with the installed Android SDK, run without a device. */
public final class NotesMonthSaveTest {
 public static void main(String[] args)throws Exception{
  Map<String,Object> file=NotesModelTest.map(NotesModelTest.fixture("month-save-vectors.json"));
  byte[] key=NotesCrypto.unhex((String)file.get("key"));
  for(Object item:NotesModelTest.list(file.get("vectors"))){
   Map<String,Object> v=NotesModelTest.map(item);
   NotesModel.Stored old=v.get("existing")==null?null:NotesModel.Stored.decode(v.get("existing"));
   boolean allowed=NotesRepository.validMonthSave(key,(String)v.get("id"),old,NotesModel.parse(v.get("content")));
   NotesModelTest.check(allowed==Boolean.TRUE.equals(v.get("allowed")),(String)v.get("name"));
  }
  System.out.println("Notes month save: "+NotesModelTest.checks+" shared checks passed");
 }
}
