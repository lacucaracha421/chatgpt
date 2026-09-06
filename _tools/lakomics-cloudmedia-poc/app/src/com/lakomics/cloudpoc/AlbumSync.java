package com.lakomics.cloudpoc;

import android.content.Context;
import android.util.AtomicFile;
import android.os.SystemClock;
import org.json.*;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

/** Refreshes only the chosen albums; failures preserve the last successful snapshot. */
final class AlbumSync {
    private static long lastAttempt = -10000;
    private static final int MAX_BYTES = 16 * 1024 * 1024;

    static synchronized JSONObject load(Context context, boolean refresh) throws Exception {
        JSONObject connection = readFile(new File(context.getFilesDir(), "connection.json"));
        File cache = new File(context.getFilesDir(), "album-cache.json");
        JSONObject snapshot = null;
        try { snapshot = readFile(cache); } catch (Exception ignored) { }
        if (refresh && SystemClock.elapsedRealtime() - lastAttempt >= 10000) {
            lastAttempt = SystemClock.elapsedRealtime();
            HttpURLConnection request = null;
            try {
                String base = connection.getString("base");
                JSONArray selected = connection.getJSONArray("albums");
                StringBuilder url = new StringBuilder(base + "/v1/library/album-media?");
                Set<String> allowed = new HashSet<>();
                for (int i=0;i<selected.length();i++) {
                    String id = selected.getJSONObject(i).getString("id"); allowed.add(id);
                    if(i>0)url.append('&');url.append("album_id=").append(URLEncoder.encode(id,"UTF-8"));
                }
                URL endpoint = new URL(url.toString());
                if (!endpoint.getProtocol().equals("https")) {
                    String[] parts = endpoint.getHost().split("\\.");
                    if(!endpoint.getProtocol().equals("http") || parts.length!=4 || !parts[0].equals("100") || Integer.parseInt(parts[1])<64 || Integer.parseInt(parts[1])>127)throw new IOException("Invalid API transport");
                }
                request = (HttpURLConnection)endpoint.openConnection();
                request.setConnectTimeout(4000);request.setReadTimeout(4000);request.setInstanceFollowRedirects(false);
                request.setRequestProperty("Authorization","Bearer "+connection.getString("token"));
                if(snapshot!=null)request.setRequestProperty("If-None-Match","\""+snapshot.getString("revision")+"\"");
                int code=request.getResponseCode();
                if(code==200) {
                    JSONObject incoming;
                    try(InputStream in=request.getInputStream()){incoming=read(in);}
                    validate(incoming,allowed);
                    AtomicFile file=new AtomicFile(cache);FileOutputStream out=null;
                    try {out=file.startWrite();out.write(incoming.toString().getBytes(StandardCharsets.UTF_8));file.finishWrite(out);}
                    catch(Exception e){if(out!=null)file.failWrite(out);throw e;}
                    snapshot=incoming;
                    android.util.Log.i("LakomicsCMP","Album metadata refreshed: "+incoming.getJSONArray("media").length());
                } else if(code!=304)throw new IOException("Album endpoint unavailable");
            } catch(Exception ignored) {
                android.util.Log.w("LakomicsCMP","Album refresh unavailable; retaining previous snapshot");
            } finally {if(request!=null)request.disconnect();}
        }
        if(snapshot!=null) {
            // Display aliases stay tied to the configured IDs, even after a server-side rename.
            JSONArray aliases=connection.getJSONArray("albums");
            JSONObject merged=new JSONObject(snapshot.toString());
            JSONArray albums=merged.getJSONArray("albums");
            for(int i=0;i<albums.length();i++)for(int j=0;j<aliases.length();j++) {
                if(albums.getJSONObject(i).getString("id").equals(aliases.getJSONObject(j).getString("id")))
                    albums.getJSONObject(i).put("name",aliases.getJSONObject(j).getString("name"));
            }
            connection.put("albums",albums);connection.put("media",merged.getJSONArray("media"));
            connection.put("revision",merged.getString("revision"));connection.put("generation",merged.getLong("generation"));
        }
        return connection;
    }

    private static void validate(JSONObject value, Set<String> allowed) throws Exception {
        if(!value.getString("revision").matches("[a-f0-9]{64}") || value.getLong("generation")<1)throw new IOException("Invalid revision");
        Set<String> albumIds=new HashSet<>(),ids=new HashSet<>();JSONArray albums=value.getJSONArray("albums"),media=value.getJSONArray("media");
        for(int i=0;i<albums.length();i++){JSONObject a=albums.getJSONObject(i);String id=a.getString("id");if(!allowed.contains(id)||!albumIds.add(id)||a.getString("name").isEmpty())throw new IOException("Invalid album");}
        for(int i=0;i<media.length();i++) {
            JSONObject m=media.getJSONObject(i);String id=m.getString("id");
            if(!id.matches("[a-zA-Z0-9-]+")||!ids.add(id)||m.getLong("size")<=0||m.getLong("date")<0||m.getInt("width")<0||m.getInt("height")<0||m.getLong("duration")<0)throw new IOException("Invalid media");
            String mime=m.getString("mime");if(!mime.startsWith("image/")&&!mime.startsWith("video/"))throw new IOException("Invalid media type");
            JSONArray membership=m.getJSONArray("albums");if(membership.length()==0)throw new IOException("Missing membership");
            for(int j=0;j<membership.length();j++)if(!albumIds.contains(membership.getString(j)))throw new IOException("Invalid membership");
        }
    }
    private static JSONObject readFile(File path)throws Exception {try(InputStream in=new FileInputStream(path)){return read(in);}}
    private static JSONObject read(InputStream in)throws Exception {
        ByteArrayOutputStream out=new ByteArrayOutputStream();byte[] bytes=new byte[8192];int count;
        while((count=in.read(bytes))!=-1){if(out.size()+count>MAX_BYTES)throw new IOException("Snapshot too large");out.write(bytes,0,count);}
        return new JSONObject(new String(out.toByteArray(),StandardCharsets.UTF_8));
    }
}
