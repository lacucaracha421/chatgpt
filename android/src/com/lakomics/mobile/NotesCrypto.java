package com.lakomics.mobile;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
/** Wire compatible with the PC AES-256-GCM Notes envelope. */
final class NotesCrypto {
 static String hex(byte[] bytes){StringBuilder out=new StringBuilder();for(byte b:bytes)out.append(String.format("%02x",b&255));return out.toString();}
 static byte[] unhex(String text){if(text==null||text.length()%2!=0||!text.matches("[a-fA-F0-9]*"))throw new IllegalArgumentException("Invalid notes key");byte[] b=new byte[text.length()/2];for(int i=0;i<b.length;i++)b[i]=(byte)Integer.parseInt(text.substring(i*2,i*2+2),16);return b;}
 static String vault(byte[] key)throws Exception{return hex(MessageDigest.getInstance("SHA-256").digest(key));}
 static byte[] nonce(){byte[] value=new byte[12];new SecureRandom().nextBytes(value);return value;}
 static byte[] crypt(int mode,byte[] key,String id,byte[] nonce,byte[] value)throws Exception{
  if(key.length!=32||nonce.length!=12||!id.matches("[a-f0-9-]{32,64}"))throw new IllegalArgumentException("Invalid notes envelope");
  Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(mode,new SecretKeySpec(key,"AES"),new GCMParameterSpec(128,nonce));
  cipher.updateAAD(("lakomics-notes:1:"+vault(key)+":"+id).getBytes(StandardCharsets.UTF_8));return cipher.doFinal(value);
 }
}
