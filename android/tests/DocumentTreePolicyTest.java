package com.lakomics.mobile;
import java.util.*;
public final class DocumentTreePolicyTest {
 static int checks=0;
 static final Map<String,String> parents=new HashMap<>();
 static void check(boolean expected,String parent,String child,String page,String... membership){boolean actual=DocumentTreePolicy.isChild(parent,child,page,parents,Arrays.asList(membership));if(actual!=expected)throw new AssertionError(parent+" -> "+child);checks++;}
 public static void main(String[] args){parents.put("subC","C");parents.put("other","rootClass");
  check(false,"page:C-later","class:C",null);check(false,"page:C-later","class:subC",null);check(false,"page:C-later","asset:earlier",null,"C");check(false,"page:C-later","asset:later",null,"C");check(false,"page:C-later","page:C-earlier","C");check(false,"page:C-later","page:C-sibling","C");
  check(true,"class:C","asset:direct",null,"C");check(true,"class:C","asset:descendant",null,"subC");check(false,"class:C","asset:unrelated",null,"other");check(true,"class:C","class:subC",null);check(false,"class:C","class:C",null);check(false,"class:subC","class:C",null);check(true,"class:C","page:C-later","C");
  check(true,"all","asset:any",null);check(true,"all","page:all-later","");check(false,"all","class:C",null);check(false,"all","page:C-later","C");check(true,"root","class:C",null);
  parents.put("cycle1","cycle2");parents.put("cycle2","cycle1");check(false,"class:C","asset:cycle",null,"cycle1");
  // The Albums section is a separate subtree: it is reachable from the root, it contains
  // Albums only, and it never reaches into the Classification namespace.
  check(true,"root","albums",null);
  check(true,"albums","album:root",null);
  check(true,"albums","album:child",null);
  check(false,"albums","class:C",null);
  check(false,"albums","asset:any",null,"C");
  check(false,"albums","all",null);
  check(false,"albums","page:x","");
  check(false,"albums","albums",null);
  // An Album grants no asset subtree: no membership-check route exists, so inventing a
  // grant from cached replica state would widen a tree grant without server evidence.
  check(false,"album:root","asset:direct",null,"C");
  check(false,"album:root","album:child",null);
  check(false,"album:root","class:C",null);
  check(false,"album:root","album:root",null);
  check(false,"album:root","album-page:x","albums");
  // The Classification tree cannot reach the Album namespace in either direction.
  check(false,"class:C","album:root",null);
  check(false,"class:C","albums",null);
  check(false,"all","albums",null);
  check(false,"all","album:root",null);
  check(false,"root","album:root",null);
  check(false,"page:C-later","album:root",null);
  check(false,"page:C-later","albums",null);
  // Continuation folders remain navigation-only in both subtrees.
  check(false,"album-page:x","album:root","albums");
  check(false,"album-page:x","asset:any",null,"C");
  System.out.println("DocumentTreePolicy: "+checks+" checks passed");
 }
}
