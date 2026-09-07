package com.lakomics.mobile;
import java.util.*;
/** Classification ancestry only. Continuation folders are navigation, never grant roots. */
final class DocumentTreePolicy {
 static boolean isChild(String parent,String child,String pageClass,Map<String,String> parents,List<String> memberships){
  if(parent.equals(child) || parent.startsWith("page:"))return false;
  if(parent.equals("root"))return child.equals("all")||child.startsWith("class:")||child.startsWith("asset:")||child.startsWith("page:");
  if(parent.equals("all"))return child.startsWith("asset:") || (child.startsWith("page:") && "".equals(pageClass));
  if(!parent.startsWith("class:"))return false;
  String ancestor=parent.substring(6);
  if(child.startsWith("asset:")){for(String id:memberships)if(descendant(id,ancestor,parents))return true;return false;}
  if(child.startsWith("class:"))return descendant(child.substring(6),ancestor,parents);
  return child.startsWith("page:") && pageClass!=null && descendant(pageClass,ancestor,parents);
 }
 private static boolean descendant(String child,String parent,Map<String,String> parents){Set<String> seen=new HashSet<>();while(child!=null && seen.add(child)){if(child.equals(parent))return true;child=parents.get(child);}return false;}
}
