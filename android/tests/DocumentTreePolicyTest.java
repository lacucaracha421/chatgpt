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
  System.out.println("DocumentTreePolicy: "+checks+" checks passed");
 }
}
