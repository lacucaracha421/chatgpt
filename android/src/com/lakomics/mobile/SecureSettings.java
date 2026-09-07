package com.lakomics.mobile;
import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import org.json.JSONObject;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
final class SecureSettings {
 private final Context context;
 SecureSettings(Context c){context=c.getApplicationContext();}
 private SecretKey key() throws Exception {
  KeyStore ks=KeyStore.getInstance("AndroidKeyStore");ks.load(null);
  if(!ks.containsAlias("lakomics.connection")){KeyGenerator g=KeyGenerator.getInstance("AES","AndroidKeyStore");g.init(new KeyGenParameterSpec.Builder("lakomics.connection",KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());g.generateKey();}
  return (SecretKey)ks.getKey("lakomics.connection",null);
 }
 synchronized JSONObject read() throws Exception {
  String stored=context.getSharedPreferences("connection",0).getString("encrypted",null);if(stored==null)return new JSONObject();
  JSONObject envelope=new JSONObject(stored);Cipher c=Cipher.getInstance("AES/GCM/NoPadding");c.init(Cipher.DECRYPT_MODE,key(),new GCMParameterSpec(128,Base64.decode(envelope.getString("iv"),0)));
  return new JSONObject(new String(c.doFinal(Base64.decode(envelope.getString("data"),0)),"UTF-8"));
 }
 static void validateToken(String token){if(token==null || token.isEmpty() || token.length()>4096 || token.contains("\r") || token.contains("\n"))throw new IllegalArgumentException("Invalid token");}
 synchronized void write(String endpoint,String token,boolean allow) throws Exception {
  endpoint=NetworkPolicy.endpoint(endpoint,allow);validateToken(token);
  JSONObject value=new JSONObject().put("endpoint",endpoint).put("token",token);Cipher c=Cipher.getInstance("AES/GCM/NoPadding");c.init(Cipher.ENCRYPT_MODE,key());
  String encrypted=new JSONObject().put("iv",Base64.encodeToString(c.getIV(),2)).put("data",Base64.encodeToString(c.doFinal(value.toString().getBytes("UTF-8")),2)).toString();
  if(!context.getSharedPreferences("connection",0).edit().putString("encrypted",encrypted).commit())throw new Exception("Cannot store connection");
 }
 synchronized void clear() throws Exception {if(!context.getSharedPreferences("connection",0).edit().clear().commit())throw new Exception("Cannot clear connection");}
 JSONObject status() throws Exception {JSONObject s=read();return new JSONObject().put("configured",s.has("token")).put("endpoint",s.optString("endpoint",""));}
}
