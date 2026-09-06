# Personal-device Android album provider

This experimental APK exposes configured Lakomics albums through Android Photo Picker. It uses the existing cloud media-ticket API and the album metadata replica. It is not a production Android release.

## Build

Install JDK 17 (`JAVA_HOME`) and Android SDK platform 35 / build-tools 35.0.0. From the `app` subdirectory, run:

```powershell
./build-albums.ps1 -SdkRoot <Android-SDK-directory>
```

The output is `app/build/lakomics-albums.apk`. A local debug signing key is created only if absent. Preserve your existing local key to upgrade the installed test package; keys, APKs, caches, screenshots and downloaded tools are excluded from Git.

Install using ADB, then provision the chosen album IDs with `app/provision-albums.py --library <library.sqlite> --serial <device-serial> --album '<id>=<display-name>'`. The script expects ADB in `platform-tools/adb.exe`. It reads the existing Windows Lakomics Cloud API credential and transfers connection data directly into the app sandbox through stdin, never into the APK or shared storage. The initial membership snapshot is subsequently refreshed through `/v1/library/album-media` when the Photo Picker queries collection information.

Only configured albums are exposed. An empty album is omitted until populated; no automatic media deletion occurs. Album removal updates the view without deleting originals. Device-specific provider eligibility, sticky override commands, verification evidence, and limitations are recorded in `docs/research/android-cloud-media-provider-poc-20260906.md` at the repository root.
