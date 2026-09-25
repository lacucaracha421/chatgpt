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
 synchronized String notesKey(String endpoint,String value)throws Exception{
  String name="notes-key-"+ThumbnailCache.key(endpoint);
  android.content.SharedPreferences preferences=context.getSharedPreferences("notes-keys",0);
  if(value==null){String stored=preferences.getString(name,null);if(stored==null)return "";JSONObject e=new JSONObject(stored);Cipher c=Cipher.getInstance("AES/GCM/NoPadding");c.init(Cipher.DECRYPT_MODE,key(),new GCMParameterSpec(128,Base64.decode(e.getString("iv"),0)));c.updateAAD(name.getBytes("UTF-8"));return new String(c.doFinal(Base64.decode(e.getString("data"),0)),"UTF-8");}
  Cipher c=Cipher.getInstance("AES/GCM/NoPadding");c.init(Cipher.ENCRYPT_MODE,key());c.updateAAD(name.getBytes("UTF-8"));
  String encrypted=new JSONObject().put("iv",Base64.encodeToString(c.getIV(),2)).put("data",Base64.encodeToString(c.doFinal(value.getBytes("UTF-8")),2)).toString();
  if(!preferences.edit().putString(name,encrypted).commit())throw new java.io.IOException("Cannot store Notes key");return value;
 }
 /**
  * The per-device secret-note PIN verifier (salted PBKDF2, never synced or backed up), or ""
  * when none is set; a non-null value replaces it. Encrypted like the Notes key.
  */
 synchronized String notesPin(String verifier)throws Exception{
  String name="notes-pin-verifier";android.content.SharedPreferences preferences=context.getSharedPreferences("notes-pin",0);
  if(verifier==null){String stored=preferences.getString(name,null);if(stored==null)return "";JSONObject e=new JSONObject(stored);Cipher c=Cipher.getInstance("AES/GCM/NoPadding");c.init(Cipher.DECRYPT_MODE,key(),new GCMParameterSpec(128,Base64.decode(e.getString("iv"),0)));c.updateAAD(name.getBytes("UTF-8"));return new String(c.doFinal(Base64.decode(e.getString("data"),0)),"UTF-8");}
  Cipher c=Cipher.getInstance("AES/GCM/NoPadding");c.init(Cipher.ENCRYPT_MODE,key());c.updateAAD(name.getBytes("UTF-8"));
  String encrypted=new JSONObject().put("iv",Base64.encodeToString(c.getIV(),2)).put("data",Base64.encodeToString(c.doFinal(verifier.getBytes("UTF-8")),2)).toString();
  if(!preferences.edit().putString(name,encrypted).remove("failures").commit())throw new java.io.IOException("Cannot store Notes PIN");return verifier;
 }
 /** Consecutive wrong PINs and the time of the last one (Unix seconds); survives restarts. */
 synchronized long[] notesPinFailures(){String v=context.getSharedPreferences("notes-pin",0).getString("failures","");String[] p=v.split(":");try{return p.length==2?new long[]{Long.parseLong(p[0]),Long.parseLong(p[1])}:new long[]{0,0};}catch(NumberFormatException e){return new long[]{0,0};}}
 synchronized void notesPinFailures(long count,long at)throws Exception{android.content.SharedPreferences.Editor e=context.getSharedPreferences("notes-pin",0).edit();if(count<=0)e.remove("failures");else e.putString("failures",count+":"+at);if(!e.commit())throw new java.io.IOException("Cannot store PIN attempts");}
 /**
  * The per-device exchange credential for one endpoint, or "" when none is stored.
  * The library keeps its own token; the exchange refuses the shared one, so this device
  * holds a second, device-only token. Keyed by endpoint like the Notes key.
  */
 synchronized String exchangeToken(String endpoint)throws Exception{
  String name="exchange-token-"+ThumbnailCache.key(endpoint);String stored=context.getSharedPreferences("exchange-tokens",0).getString(name,null);if(stored==null)return "";
  JSONObject e=new JSONObject(stored);Cipher c=Cipher.getInstance("AES/GCM/NoPadding");c.init(Cipher.DECRYPT_MODE,key(),new GCMParameterSpec(128,Base64.decode(e.getString("iv"),0)));c.updateAAD(name.getBytes("UTF-8"));return new String(c.doFinal(Base64.decode(e.getString("data"),0)),"UTF-8");
 }
 synchronized void writeExchangeToken(String endpoint,String token)throws Exception{
  String name="exchange-token-"+ThumbnailCache.key(endpoint);android.content.SharedPreferences preferences=context.getSharedPreferences("exchange-tokens",0);
  if(token==null||token.isEmpty()){if(!preferences.edit().remove(name).commit())throw new java.io.IOException("Cannot clear exchange token");return;}
  validateToken(token);Cipher c=Cipher.getInstance("AES/GCM/NoPadding");c.init(Cipher.ENCRYPT_MODE,key());c.updateAAD(name.getBytes("UTF-8"));
  String encrypted=new JSONObject().put("iv",Base64.encodeToString(c.getIV(),2)).put("data",Base64.encodeToString(c.doFinal(token.getBytes("UTF-8")),2)).toString();
  if(!preferences.edit().putString(name,encrypted).commit())throw new java.io.IOException("Cannot store exchange token");
 }
 synchronized void clearExchangeTokens()throws Exception{if(!context.getSharedPreferences("exchange-tokens",0).edit().clear().commit())throw new Exception("Cannot clear exchange tokens");}
 synchronized void clear() throws Exception {if(!context.getSharedPreferences("connection",0).edit().clear().commit())throw new Exception("Cannot clear connection");}
 JSONObject status() throws Exception {JSONObject s=read();return new JSONObject().put("configured",s.has("token")).put("endpoint",s.optString("endpoint",""));}
}
