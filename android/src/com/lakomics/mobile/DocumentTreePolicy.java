package com.lakomics.mobile;
import java.util.*;
/**
 * Document-tree ancestry policy.
 *
 * Two independent subtrees are reachable from the root: the long-standing Classification
 * tree (`class:`/`page:`), which is unchanged, and the additive Albums section
 * ({@link #ALBUMS}/`album:`/`album-page:`) introduced by 2C-2. They are separate product
 * domains, so neither namespace contains or implies the other.
 *
 * Continuation folders are navigation, never grant roots.
 */
final class DocumentTreePolicy {
 /** The explicit Albums section directory id. Album nodes live only under it. */
 static final String ALBUMS="albums";
 static boolean isChild(String parent,String child,String pageClass,Map<String,String> parents,List<String> memberships){
  if(parent.equals(child) || parent.startsWith("page:") || parent.startsWith("album-page:"))return false;
  // The Albums section contains Albums and nothing else.
  if(parent.equals(ALBUMS))return child.startsWith("album:");
  // An Album lists its Assets from the authority read, but a tree grant requires current
  // server evidence that the relation holds. No such membership-check route exists, so an
  // Album grants no asset subtree instead of inventing a grant from cached state.
  if(parent.startsWith("album:"))return false;
  // Nothing in the Album namespace is reachable through the Classification tree.
  if(child.startsWith("album:"))return false;
  if(parent.equals("root"))return child.equals("all")||child.startsWith("class:")||child.startsWith("asset:")||child.startsWith("page:")||child.equals(ALBUMS);
  if(parent.equals("all"))return child.startsWith("asset:") || (child.startsWith("page:") && "".equals(pageClass));
  if(!parent.startsWith("class:"))return false;
  String ancestor=parent.substring(6);
  if(child.startsWith("asset:")){for(String id:memberships)if(descendant(id,ancestor,parents))return true;return false;}
  if(child.startsWith("class:"))return descendant(child.substring(6),ancestor,parents);
  return child.startsWith("page:") && pageClass!=null && descendant(pageClass,ancestor,parents);
 }
 private static boolean descendant(String child,String parent,Map<String,String> parents){Set<String> seen=new HashSet<>();while(child!=null && seen.add(child)){if(child.equals(parent))return true;child=parents.get(child);}return false;}
}
