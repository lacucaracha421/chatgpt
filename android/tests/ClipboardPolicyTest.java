package com.lakomics.mobile;
public final class ClipboardPolicyTest {
 interface Attempt {void run()throws Exception;}
 static int checks=0;
 static void reject(Attempt a)throws Exception {try{a.run();}catch(Exception e){checks++;return;}throw new AssertionError("Invalid copy text accepted");}
 public static void main(String[] args)throws Exception {
  if(!ClipboardPolicy.text("작가 정보").equals("작가 정보"))throw new AssertionError();checks++;
  if(!ClipboardPolicy.text("https://example.com/a").equals("https://example.com/a"))throw new AssertionError();checks++;
  // A single character and the exact cap are both legal; one over is not.
  if(!ClipboardPolicy.text("x").equals("x"))throw new AssertionError();checks++;
  final StringBuilder cap=new StringBuilder();while(cap.length()<ClipboardPolicy.MAX_LENGTH)cap.append('a');
  if(ClipboardPolicy.text(cap.toString()).length()!=ClipboardPolicy.MAX_LENGTH)throw new AssertionError();checks++;
  reject(()->ClipboardPolicy.text(null));
  reject(()->ClipboardPolicy.text(""));
  reject(()->ClipboardPolicy.text(cap.toString()+"a"));
  // The clip label is stable and carries no asset identity.
  if(!ClipboardPolicy.label().equals("Lakomics"))throw new AssertionError();checks++;
  System.out.println("ClipboardPolicy: "+checks+" checks passed");
 }
}
