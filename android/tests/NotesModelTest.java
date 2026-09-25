package com.lakomics.mobile;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.*;
import javax.crypto.Cipher;
/** Shared Notes v2 fixtures (tests/fixtures/notes-v2) plus the Android-only model, draft and PIN rules. */
public final class NotesModelTest {
 static int checks=0;
 static void check(boolean ok,String what){if(!ok)throw new AssertionError(what);checks++;}
 @SuppressWarnings("unchecked") static Map<String,Object> map(Object v){return (Map<String,Object>)v;}
 @SuppressWarnings("unchecked") static List<Object> list(Object v){return (List<Object>)v;}
 static Object fixture(String name)throws Exception{
  String dir=System.getProperty("notes.fixtures");if(dir==null)throw new AssertionError("-Dnotes.fixtures is required");
  return Json.parse(new String(Files.readAllBytes(Paths.get(dir,name)),StandardCharsets.UTF_8),4*1024*1024,64);
 }
 /** Serialize and read back, so maps compare structurally and numbers compare as the reader types them. */
 static Object roundtrip(Object value){return Json.parse(NotesModel.write(value),4*1024*1024,64);}
 public static void main(String[] args)throws Exception{
  int merges=mergeVectors(),examples=payloadExamples(),undecodable=undecodable();
  envelope();model();drafts();pin();
  System.out.println("NotesModel: "+merges+" merge vectors, "+examples+" payload examples, "+undecodable+" undecodable payloads, "+checks+" checks passed");
 }
 static int mergeVectors()throws Exception{
  List<Object> vectors=list(map(fixture("merge-vectors.json")).get("vectors"));check(vectors.size()>=15,"vector count");
  for(Object entry:vectors){
   Map<String,Object> v=map(entry);String name=(String)v.get("name");
   NotesModel.Content result=NotesModel.merge(NotesModel.parse(v.get("base")),NotesModel.parse(v.get("local")),NotesModel.parse(v.get("remote")));
   Map<String,Object> expected=map(v.get("expected"));
   if(Boolean.TRUE.equals(expected.get("conflict")))check(result==null,name+": expected a collision");
   else{check(result!=null,name+": unexpected collision");check(roundtrip(result.toMap()).equals(expected),name+": merged "+result.toJson());}
  }
  return vectors.size();
 }
 static int payloadExamples()throws Exception{
  List<Object> examples=list(map(fixture("payload-examples.json")).get("examples"));
  for(Object entry:examples){
   Map<String,Object> e=map(entry);String name=(String)e.get("name");Object payload=e.get("payload");
   NotesModel.Content content=NotesModel.parse(payload);
   check(roundtrip(content.toMap()).equals(payload),name+": exact shape");
   check(content.supported()==Boolean.TRUE.equals(e.get("supported")),name+": supported");
   NotesModel.Stored stored=NotesModel.Stored.decode(payload);
   check(stored.isRaw()!=content.supported(),name+": decode guard");
   if(content.supported()){
    NotesModel.Content normalized=content.copy();normalized.normalize();
    check(normalized.body.equals(content.body),name+": fallback body");
    check((content.validate()==null)==Boolean.TRUE.equals(e.get("valid")),name+": valid");
   }
  }
  return examples.size();
 }
 static int undecodable()throws Exception{
  List<Object> cases=list(map(fixture("payload-examples.json")).get("undecodable"));
  for(Object entry:cases){
   Map<String,Object> c=map(entry);String name=(String)c.get("name");Object payload=c.get("payload");
   NotesModel.Stored stored=NotesModel.Stored.decode(payload);check(stored.isRaw(),name+": read-only raw");
   check(NotesModel.Stored.decode(roundtrip(payload)).isRaw(),name+": stays raw");
   Map<String,Object> view=NotesModel.view("id",stored,3,false,false,true);
   check(view.get("title").equals(map(c.get("shows")).get("title")),name+": readable title");
   check(Boolean.TRUE.equals(view.get("readOnly")),name+": readOnly flag");
   // Pin/trash/archive patch only those keys (plus updatedAt); every other byte is kept.
   NotesModel.Draft d=new NotesModel.Draft();d.pinned=true;d.archived=true;d.title="무시";d.body="무시";
   Map<String,Object> patched=map(NotesModel.patchRaw(payload,d,"2026-09-25T00:00:00Z"));
   check(Boolean.TRUE.equals(patched.get("pinned"))&&Boolean.TRUE.equals(patched.get("archived"))&&"2026-09-25T00:00:00Z".equals(patched.get("updatedAt")),name+": patched flags");
   for(Map.Entry<String,Object> k:map(payload).entrySet())if(!Arrays.asList("pinned","archived","updatedAt").contains(k.getKey()))check(Objects.equals(patched.get(k.getKey()),k.getValue()),name+": kept "+k.getKey());
  }
  return cases.size();
 }
 static void envelope()throws Exception{
  Map<String,Object> file=map(fixture("payload-examples.json")),env=map(file.get("envelope")),sealed=map(env.get("envelope"));
  byte[] key=NotesCrypto.unhex((String)env.get("key"));String id=(String)env.get("id");
  check(Long.valueOf(1).equals(sealed.get("version")),"envelope version");
  String plain=new String(NotesCrypto.crypt(Cipher.DECRYPT_MODE,key,id,NotesCrypto.unhex((String)sealed.get("nonce")),NotesCrypto.unhex((String)sealed.get("ciphertext"))),StandardCharsets.UTF_8);
  Object expected=null;for(Object e:list(file.get("examples")))if(map(e).get("name").equals(env.get("payloadExample")))expected=map(e).get("payload");
  check(expected!=null&&NotesModel.parsePayload(plain).equals(expected),"PC v2 envelope opens to the checklist example");
  NotesModel.Stored stored=NotesModel.Stored.decode(NotesModel.parsePayload(plain));check(!stored.isRaw()&&"checklist".equals(stored.typed.kind()),"v2 envelope decodes typed");
  // The reverse direction: what Android seals, the same key and AAD open.
  byte[] nonce=NotesCrypto.nonce();byte[] out=NotesCrypto.crypt(Cipher.ENCRYPT_MODE,key,id,nonce,stored.toJson().getBytes(StandardCharsets.UTF_8));
  check(NotesModel.parsePayload(new String(NotesCrypto.crypt(Cipher.DECRYPT_MODE,key,id,nonce,out),StandardCharsets.UTF_8)).equals(expected),"Android seal round trip");
 }
 static NotesModel.Item item(String id,String order){return new NotesModel.Item(id,"xxxxxxxxxx",false,order);}
 static void model()throws Exception{
  String v1="{\"title\":\"메모\",\"body\":\"PC와 모바일\",\"pinned\":false,\"deleted\":false,\"createdAt\":\"a\",\"updatedAt\":\"b\"}";
  NotesModel.Content c=NotesModel.parse(Json.parse(v1));c.normalize();check(c.toJson().equals(v1),"v1 keeps its exact bytes");
  NotesModel.Content list=NotesModel.Content.fresh("now");list.kind="checklist";list.items=new ArrayList<>();
  for(int i=0;i<=NotesModel.MAX_ITEMS;i++)list.items.add(item("i"+i,"a"+i));list.normalize();check(list.validate()!=null,"too many items");
  NotesModel.Item longItem=item("a","a");StringBuilder big=new StringBuilder();for(int i=0;i<=NotesModel.MAX_ITEM_CHARS;i++)big.append('가');longItem.text=big.toString();
  list.items=new ArrayList<>(Collections.singletonList(longItem));check(list.validate()!=null,"item too long");
  list.items=new ArrayList<>(Arrays.asList(item("a","a"),item("a","b")));check(list.validate()!=null,"duplicate ids");
  list.items=new ArrayList<>(Collections.singletonList(item("a","")));check(list.validate()!=null,"empty order");
  list.items=new ArrayList<>(Collections.singletonList(item("a","a")));check(list.validate()==null,"valid item");
  list.labels=Arrays.asList("Work","work");check(list.validate()!=null,"case-insensitive duplicate label");
  list.labels=Collections.singletonList(" padded");check(list.validate()!=null,"padded label");
  list.labels=Collections.singletonList("업무");list.color="Amber!";check(list.validate()!=null,"bad colour");
  list.color="amber";check(list.validate()==null,"good colour");
  NotesModel.Content fb=NotesModel.Content.fresh("now");fb.kind="checklist";
  NotesModel.Item done=new NotesModel.Item("b","done",true,"a"),two=new NotesModel.Item("c","two\nlines",false,"c"),first=new NotesModel.Item("a","first",false,"b");
  fb.items=new ArrayList<>(Arrays.asList(done,two,first));fb.normalize();
  check(fb.body.equals("- [ ] first\n- [ ] two lines\n- [x] done")&&Long.valueOf(2).equals(fb.schema),"checklist fallback");
  NotesModel.Content s=NotesModel.Content.fresh("now");s.kind="secret";s.memo="참고";s.fields=new ArrayList<>(Collections.singletonList(new NotesModel.Field("f","API 키","abc","a")));s.normalize();
  check(s.body.equals("API 키: abc\n\n참고"),"secret fallback");
  // A wrong-typed payload or an over-limit title never decodes as typed.
  check(NotesModel.Stored.decode(Json.parse("[1,2]")).isRaw(),"non-object payload is raw");
  StringBuilder title=new StringBuilder();for(int i=0;i<201;i++)title.append('t');
  check(NotesModel.Stored.decode(Json.parse("{\"title\":\""+title+"\",\"body\":\"\",\"pinned\":false,\"deleted\":false,\"createdAt\":\"a\",\"updatedAt\":\"b\"}")).isRaw(),"over-limit title is raw");
  // A redacted secret view carries only the title and metadata; unknown keys never reach the WebView.
  NotesModel.Content secret=NotesModel.parse(Json.parse("{\"schema\":2,\"type\":\"secret\",\"title\":\"계정\",\"body\":\"id: x\",\"memo\":\"m\",\"labels\":[\"l\"],\"fields\":[{\"id\":\"f\",\"label\":\"id\",\"value\":\"x\",\"order\":\"V\",\"hint\":1}],\"pinned\":false,\"deleted\":false,\"createdAt\":\"a\",\"updatedAt\":\"b\",\"future\":true}"));
  Map<String,Object> redacted=NotesModel.view("n",NotesModel.Stored.typed(secret),1,false,false,false);
  String shown=NotesModel.write(redacted);
  check(Boolean.TRUE.equals(redacted.get("redacted"))&&"".equals(redacted.get("body"))&&!shown.contains("\"x\"")&&!shown.contains("memo")&&!shown.contains("labels")&&!shown.contains("future"),"redacted secret view");
  Map<String,Object> open=NotesModel.view("n",NotesModel.Stored.typed(secret),1,false,false,true);String opened=NotesModel.write(open);
  check(opened.contains("\"value\":\"x\"")&&!opened.contains("future")&&!opened.contains("hint"),"open secret view drops unknown keys");
 }
 static NotesModel.Draft draft(String json)throws Exception{return NotesModel.draft(Json.parse(json));}
 static void drafts()throws Exception{
  String now="2026-09-25T00:00:00Z";NotesModel.SecretOpen open=()->true,closed=()->false;
  NotesModel.Content text=NotesModel.parse(Json.parse("{\"title\":\"t\",\"body\":\"b\",\"pinned\":false,\"deleted\":false,\"createdAt\":\"a\",\"updatedAt\":\"b\",\"reminder\":\"r\"}"));
  NotesModel.Content saved=NotesModel.applyDraft(text,draft("{\"id\":\"x\",\"expectedRevision\":1,\"type\":\"text\",\"title\":\"t2\",\"body\":\"b2\",\"color\":null,\"labels\":[]}"),now,open);
  check(saved.schema==null&&saved.kind==null&&"r".equals(saved.extra.get("reminder"))&&"t2".equals(saved.title),"text save keeps v1 shape and unknown keys");
  NotesModel.Content coloured=NotesModel.applyDraft(saved,draft("{\"id\":\"x\",\"expectedRevision\":2,\"color\":\"teal\"}"),now,open);
  check("teal".equals(coloured.color)&&Long.valueOf(2).equals(coloured.schema),"colour marks schema 2");
  check(NotesModel.applyDraft(coloured,draft("{\"id\":\"x\",\"expectedRevision\":3,\"color\":null}"),now,open).color==null,"null clears colour");
  check("teal".equals(NotesModel.applyDraft(coloured,draft("{\"id\":\"x\",\"expectedRevision\":3,\"title\":\"z\"}"),now,open).color),"absent keeps colour");
  NotesModel.Content checklist=NotesModel.parse(Json.parse("{\"schema\":2,\"type\":\"checklist\",\"title\":\"c\",\"body\":\"- [ ] a\",\"items\":[{\"id\":\"i1\",\"text\":\"a\",\"checked\":false,\"order\":\"V\",\"due\":\"x\"}],\"pinned\":false,\"deleted\":false,\"createdAt\":\"a\",\"updatedAt\":\"b\"}"));
  NotesModel.Content checked=NotesModel.applyDraft(checklist,draft("{\"id\":\"x\",\"expectedRevision\":1,\"items\":[{\"id\":\"i1\",\"text\":\"a\",\"checked\":true,\"order\":\"V\"}]}"),now,open);
  check("x".equals(checked.items.get(0).extra.get("due"))&&checked.body.equals("- [x] a"),"item extras restored by id and fallback rebuilt");
  try{NotesModel.applyDraft(checklist,draft("{\"id\":\"x\",\"expectedRevision\":1,\"type\":\"secret\"}"),now,open);check(false,"conversion to secret");}catch(NotesModel.Invalid expected){checks++;}
  NotesModel.Content secret=NotesModel.applyDraft(null,draft("{\"id\":\"x\",\"expectedRevision\":0,\"type\":\"secret\",\"title\":\"s\",\"fields\":[],\"memo\":\"\"}"),now,open);
  try{NotesModel.applyDraft(secret,draft("{\"id\":\"x\",\"expectedRevision\":1,\"memo\":\"leak\"}"),now,closed);check(false,"locked secret save");}catch(NotesModel.SecretLocked expected){checks++;}
  check(NotesModel.applyDraft(secret,draft("{\"id\":\"x\",\"expectedRevision\":1,\"pinned\":true,\"title\":\"s2\"}"),now,closed).pinned,"metadata save of a locked secret");
  try{draft("{\"id\":\"x\",\"expectedRevision\":1,\"items\":[{\"id\":\"a\",\"text\":\"a\",\"order\":3}]}");check(false,"wrong-typed draft");}catch(NotesModel.Shape expected){checks++;}
  StringBuilder big=new StringBuilder();for(int i=0;i<=NotesModel.MAX_BODY_BYTES;i++)big.append('a');
  try{NotesModel.applyDraft(text,draft("{\"id\":\"x\",\"expectedRevision\":1,\"body\":\""+big+"\"}"),now,open);check(false,"over-limit body");}catch(NotesModel.Invalid expected){checks++;}
  NotesModel.Content future=NotesModel.parse(Json.parse("{\"schema\":3,\"title\":\"f\",\"body\":\"b\",\"pinned\":false,\"deleted\":false,\"createdAt\":\"a\",\"updatedAt\":\"b\",\"x\":1}"));
  NotesModel.Content futureSaved=NotesModel.applyDraft(future,draft("{\"id\":\"x\",\"expectedRevision\":1,\"body\":\"ignored\",\"deleted\":true}"),now,open);
  check(futureSaved.deleted&&"b".equals(futureSaved.body)&&Long.valueOf(1).equals(futureSaved.extra.get("x")),"unsupported content only takes metadata");
  check(NotesModel.uuid("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")&&!NotesModel.uuid("x")&&!NotesModel.uuid(null),"uuid ids");
 }
 static void pin()throws Exception{
  check(NotesPin.valid("0000")&&NotesPin.valid("12345678"),"valid PINs");
  check(!NotesPin.valid("123")&&!NotesPin.valid("123456789")&&!NotesPin.valid("12a4")&&!NotesPin.valid("١٢٣٤")&&!NotesPin.valid(null),"invalid PINs");
  String a=NotesPin.makeVerifier("2468",1000),b=NotesPin.makeVerifier("2468",1000);
  check(!a.equals(b)&&!a.contains("2468"),"salted verifier");
  check(NotesPin.check(a,"2468")&&!NotesPin.check(a,"2469"),"verifier checks the PIN");
  check(!NotesPin.check(a.replace("\"iterations\":1000","\"iterations\":999"),"2468"),"tampered iterations");
  check(!NotesPin.check("{}","2468")&&!NotesPin.check("not json","2468"),"broken verifier");
  check(NotesPin.lockoutRemaining(4,100,100)==-1&&NotesPin.lockoutRemaining(5,100,110)==20&&NotesPin.lockoutRemaining(5,100,130)==-1,"five misses lock for 30 s");
  check(NotesPin.lockoutRemaining(6,100,100)==60&&NotesPin.lockoutRemaining(7,100,100)==300&&NotesPin.lockoutRemaining(50,100,100)==3600,"lockout escalates");
  long[] clock={0};NotesPin.Session session=new NotesPin.Session(()->clock[0]);
  check(!session.touch()&&!session.isOpen(),"session starts locked");
  session.open();clock[0]=NotesPin.IDLE_LOCK_MS-1;check(session.touch(),"activity keeps the session");
  clock[0]+=NotesPin.IDLE_LOCK_MS-1;check(session.isOpen(),"refreshed by touch");
  clock[0]+=1;check(!session.isOpen()&&!session.touch(),"idle for 5 minutes locks");
  session.open();session.lock();check(!session.isOpen(),"explicit lock");
 }
}
