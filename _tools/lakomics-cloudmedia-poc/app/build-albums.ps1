param([string]$SdkRoot = $env:ANDROID_SDK_ROOT)
$ErrorActionPreference = 'Stop'
if (-not $SdkRoot) { throw 'Pass -SdkRoot or set ANDROID_SDK_ROOT.' }
Set-Location $PSScriptRoot
$taskBuildTools = Join-Path $SdkRoot 'build-tools/35.0.0'
$taskAndroidJar = Join-Path $SdkRoot 'platforms/android-35/android.jar'
New-Item -ItemType Directory -Force build/classes-albums,build/dex-albums | Out-Null
if (-not (Test-Path build/debug.keystore)) {
    & "$env:JAVA_HOME/bin/keytool.exe" -genkeypair -keystore build/debug.keystore -storepass android -keypass android -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 10000 -dname 'CN=Android Debug,O=Android,C=US'
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
& "$env:JAVA_HOME\bin\javac.exe" -encoding UTF-8 -source 8 -target 8 -bootclasspath $taskAndroidJar -d build/classes-albums src/com/lakomics/cloudpoc/AlbumSync.java src/com/lakomics/cloudpoc/CloudAlbumProvider.java src/com/lakomics/cloudpoc/MainActivity.java
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& "$env:JAVA_HOME\bin\jar.exe" cf build/albums-classes.jar -C build/classes-albums .
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& "$taskBuildTools\d8.bat" --lib $taskAndroidJar --output build/dex-albums build/albums-classes.jar
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& "$taskBuildTools\aapt2.exe" link -o build/albums-unsigned.apk --manifest AlbumManifest.xml --version-code 10 --version-name 0.10 -I $taskAndroidJar
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
python -c "import zipfile; z=zipfile.ZipFile('build/albums-unsigned.apk','a'); z.write('build/dex-albums/classes.dex','classes.dex'); z.close()"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& "$taskBuildTools\zipalign.exe" -f 4 build/albums-unsigned.apk build/albums-aligned.apk
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& "$taskBuildTools\apksigner.bat" sign --ks build/debug.keystore --ks-pass pass:android --key-pass pass:android --out build/lakomics-albums.apk build/albums-aligned.apk
exit $LASTEXITCODE
