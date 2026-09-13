package com.lakomics.mobile;
import javax.crypto.Cipher;
import java.nio.charset.StandardCharsets;
public class NotesCryptoTest {
 public static void main(String[] args)throws Exception {
  byte[] key=NotesCrypto.unhex("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"),nonce=NotesCrypto.unhex("000102030405060708090a0b"),cipher=NotesCrypto.unhex("3c20a272b189a739b7637c222502d2c5a1faa5569f1f265e0245b5c6f1f08092eaba06171f55fe05c88653cff8ee46568b3d42b73cb7cfa95abb087d7d8f909a9558e440b5b04a127978880d9dea6f9c5dee88165459715acdcfa8ee54d2ccfdaf992d83c000bc38a43e0c827a4303023c0e7d8bb1f9d4ebd5dbca9f3a7604db");
  String id="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  String plain=new String(NotesCrypto.crypt(Cipher.DECRYPT_MODE,key,id,nonce,cipher),StandardCharsets.UTF_8);
  if(!plain.contains("PC와 모바일"))throw new AssertionError("PC envelope fixture");
  if(!NotesCrypto.hex(NotesCrypto.crypt(Cipher.ENCRYPT_MODE,key,id,nonce,plain.getBytes(StandardCharsets.UTF_8))).equals(NotesCrypto.hex(cipher)))throw new AssertionError("Wire format");
  try{NotesCrypto.crypt(Cipher.DECRYPT_MODE,key,"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",nonce,cipher);throw new AssertionError("Cross-note replay");}catch(javax.crypto.AEADBadTagException expected){}
  cipher[0]^=1;try{NotesCrypto.crypt(Cipher.DECRYPT_MODE,key,id,nonce,cipher);throw new AssertionError("Tamper accepted");}catch(javax.crypto.AEADBadTagException expected){}
  System.out.println("NotesCrypto: 4 interoperability/integrity checks passed");
 }
}
