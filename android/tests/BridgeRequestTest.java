package com.lakomics.mobile;

import java.nio.file.*;
import java.nio.charset.StandardCharsets;
import javax.tools.ToolProvider;
import java.net.URLClassLoader;

/** Execute the actual request admission method, substituting only the Android operation body. */
public final class BridgeRequestTest {
    public static void main(String[] args) throws Exception {
        Path root = Paths.get("android");
        String activity = Files.readString(root.resolve("src/com/lakomics/mobile/MainActivity.java"));
        int start = activity.indexOf("  @JavascriptInterface public void request(");
        int end = activity.indexOf("\n  }\n }\n @Override", start);
        if (start < 0 || end < 0) throw new AssertionError("request source boundaries changed");
        String method = activity.substring(start, end + 4).replace("@JavascriptInterface ", "");
        int task = method.indexOf("   final Runnable task="), dispatch = method.indexOf("\n   CancellableDispatch dispatch=");
        if (task < 0 || dispatch < task) throw new AssertionError("dispatch source boundaries changed");
        method = method.substring(0, task) + "   final Runnable task=()->runDownload(id,signal,prepared);" + method.substring(dispatch);
        method = method.replace("MainActivity.this", "BridgeRequestFixture.this");
        String fixture = Files.readString(root.resolve("tests/fixtures/bridge-request/BridgeRequestFixture.java"));
        Path output = Files.createTempDirectory("bridge-request-test-");
        Path source = output.resolve("BridgeRequestFixture.java");
        Files.writeString(source, fixture.replace("// REQUEST_METHOD", method), StandardCharsets.UTF_8);
        int result = ToolProvider.getSystemJavaCompiler().run(null, null, null, "-encoding", "UTF-8", "-d", output.toString(),
                root.resolve("src/com/lakomics/mobile/CancellableDispatch.java").toString(),
                root.resolve("src/com/lakomics/mobile/Json.java").toString(), source.toString());
        if (result != 0) throw new AssertionError("Bridge fixture compilation failed");
        try (URLClassLoader loader = new URLClassLoader(new java.net.URL[]{output.toUri().toURL()}, null)) {
            try { loader.loadClass("com.lakomics.mobile.BridgeRequestFixture").getMethod("run").invoke(null); }
            catch (java.lang.reflect.InvocationTargetException e) { throw new AssertionError(e.getCause()); }
        }
        System.out.println("BridgeRequestTest: 2 calling-thread lock scenarios passed");
    }
}
