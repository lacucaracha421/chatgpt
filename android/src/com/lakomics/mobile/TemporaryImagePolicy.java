package com.lakomics.mobile;

import java.io.IOException;
import java.net.URI;
import java.net.InetAddress;

/** Device-only image import bounds; never accepts an API endpoint or credentials. */
final class TemporaryImagePolicy {
    static final long MAX_BYTES=32L*1024*1024;
    static URI url(String value) throws Exception {
        if(value==null || value.length()>8192)throw new IOException("Invalid image URL");
        URI u=new URI(value);
        if(!"https".equals(u.getScheme()) || u.getHost()==null || u.getUserInfo()!=null || u.getFragment()!=null || (u.getPort()!=-1 && u.getPort()!=443))throw new IOException("HTTPS image required");
        return u;
    }
    static void publicHost(URI uri)throws Exception {
        for(InetAddress address:InetAddress.getAllByName(uri.getHost())) {
            byte[] b=address.getAddress();
            if(address.isAnyLocalAddress() || address.isLoopbackAddress() || address.isLinkLocalAddress() || address.isSiteLocalAddress() || address.isMulticastAddress()
                || (b.length==4 && ((b[0]&255)==0 || ((b[0]&255)==100 && (b[1]&255)>=64 && (b[1]&255)<=127)))
                || (b.length==16 && (b[0]&254)==252))throw new IOException("Public image required");
        }
    }
    static String extension(String mime)throws IOException {
        if(mime==null)throw new IOException("Invalid image");
        switch(mime){case "image/jpeg":return ".jpg";case "image/png":return ".png";case "image/webp":return ".webp";case "image/gif":return ".gif";case "image/avif":return ".avif";case "image/heif":case "image/heic":return ".heic";default:throw new IOException("Unsupported image");}
    }
}
