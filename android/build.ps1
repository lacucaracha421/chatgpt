param([string]$SdkRoot=$env:ANDROID_SDK_ROOT,[switch]$CompileOnly)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if (-not $SdkRoot) { throw 'Pass -SdkRoot or set ANDROID_SDK_ROOT.' }
if (-not $env:JAVA_HOME) { throw 'JAVA_HOME must point to JDK 17.' }
$taskTools=Join-Path $SdkRoot 'build-tools/35.0.0'
$taskJar=Join-Path $SdkRoot 'platforms/android-35/android.jar'
$taskBuild=Join-Path $PSScriptRoot 'build'
$taskClasses=Join-Path $taskBuild 'classes'
$taskDex=Join-Path $taskBuild 'dex'
foreach ($taskRequired in @($taskJar,"$taskTools/aapt2.exe","$env:JAVA_HOME/bin/javac.exe")) { if (-not (Test-Path -LiteralPath $taskRequired)) { throw "Missing build prerequisite: $taskRequired" } }
New-Item -ItemType Directory -Force $taskBuild | Out-Null
foreach ($taskFolder in @($taskClasses,$taskDex)) {
 $taskResolved=[IO.Path]::GetFullPath($taskFolder)
 if (-not $taskResolved.StartsWith([IO.Path]::GetFullPath($taskBuild)+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe build cleanup target.' }
 if (Test-Path -LiteralPath $taskResolved) { Remove-Item -LiteralPath $taskResolved -Recurse -Force }
 New-Item -ItemType Directory -Force $taskResolved | Out-Null
}
$taskSources=@(Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'src') -Filter '*.java' -Recurse | ForEach-Object FullName)
& "$env:JAVA_HOME/bin/javac.exe" -encoding UTF-8 -source 8 -target 8 -classpath $taskJar -d $taskClasses @taskSources
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$taskTests=Join-Path $taskBuild 'tests'
New-Item -ItemType Directory -Force $taskTests | Out-Null
& "$env:JAVA_HOME/bin/javac.exe" -encoding UTF-8 -d $taskTests (Join-Path $PSScriptRoot 'src/com/lakomics/mobile/NetworkPolicy.java') (Join-Path $PSScriptRoot 'tests/NetworkPolicyTest.java') (Join-Path $PSScriptRoot 'src/com/lakomics/mobile/DocumentTreePolicy.java') (Join-Path $PSScriptRoot 'tests/DocumentTreePolicyTest.java') (Join-Path $PSScriptRoot 'src/com/lakomics/mobile/ThumbnailCache.java') (Join-Path $PSScriptRoot 'tests/ThumbnailCacheTest.java') (Join-Path $PSScriptRoot 'src/com/lakomics/mobile/PickerSnapshot.java') (Join-Path $PSScriptRoot 'tests/PickerSnapshotTest.java') (Join-Path $PSScriptRoot 'src/com/lakomics/mobile/MediaTransfer.java') (Join-Path $PSScriptRoot 'tests/MediaTransferTest.java')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& "$env:JAVA_HOME/bin/java.exe" -cp $taskTests com.lakomics.mobile.NetworkPolicyTest
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& "$env:JAVA_HOME/bin/java.exe" -cp $taskTests com.lakomics.mobile.DocumentTreePolicyTest
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& "$env:JAVA_HOME/bin/java.exe" -cp $taskTests com.lakomics.mobile.ThumbnailCacheTest
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& "$env:JAVA_HOME/bin/java.exe" -cp $taskTests com.lakomics.mobile.PickerSnapshotTest
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& "$env:JAVA_HOME/bin/java.exe" -cp $taskTests com.lakomics.mobile.MediaTransferTest
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if ($CompileOnly) { Write-Output 'Native compile and network policy tests passed.'; exit 0 }
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'assets/index.html'))) { throw 'Build the app/mobile-client Vite bundle first; android/assets/index.html is required.' }
$taskKey=Join-Path $taskBuild 'debug.keystore'
if (-not (Test-Path -LiteralPath $taskKey)) {
 & "$env:JAVA_HOME/bin/keytool.exe" -genkeypair -keystore $taskKey -storepass android -keypass android -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 10000 -dname 'CN=Lakomics Debug,O=Personal,C=KR'
 if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
& "$env:JAVA_HOME/bin/jar.exe" cf "$taskBuild/classes.jar" -C $taskClasses .
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& "$taskTools/d8.bat" --min-api 26 --lib $taskJar --output $taskDex "$taskBuild/classes.jar"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& "$taskTools/aapt2.exe" compile --dir (Join-Path $PSScriptRoot 'res') -o "$taskBuild/resources.zip"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& "$taskTools/aapt2.exe" link -o "$taskBuild/unsigned.apk" --manifest (Join-Path $PSScriptRoot 'AndroidManifest.xml') -I $taskJar "$taskBuild/resources.zip"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$taskZip=[IO.Compression.ZipFile]::Open("$taskBuild/unsigned.apk",[IO.Compression.ZipArchiveMode]::Update)
try {
 [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($taskZip,"$taskDex/classes.dex",'classes.dex') | Out-Null
 # Windows aapt2 -A emits nested asset names with backslashes. Android's
 # AssetManager uses forward slashes, so write portable ZIP entry names here.
 $taskAssetRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'assets'))+[IO.Path]::DirectorySeparatorChar
 foreach($taskAsset in Get-ChildItem -LiteralPath $taskAssetRoot -Recurse -File) {
  $taskEntry='assets/'+$taskAsset.FullName.Substring($taskAssetRoot.Length).Replace('\','/')
  [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($taskZip,$taskAsset.FullName,$taskEntry) | Out-Null
 }
} finally { $taskZip.Dispose() }
& (Join-Path $PSScriptRoot 'tests/VerifyApkAssets.ps1') -ApkPath "$taskBuild/unsigned.apk" -AssetsRoot (Join-Path $PSScriptRoot 'assets')
& "$taskTools/zipalign.exe" -f 4 "$taskBuild/unsigned.apk" "$taskBuild/aligned.apk"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& "$taskTools/apksigner.bat" sign --ks $taskKey --ks-pass pass:android --key-pass pass:android --out "$taskBuild/lakomics-mobile-debug.apk" "$taskBuild/aligned.apk"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& "$taskTools/apksigner.bat" verify --verbose "$taskBuild/lakomics-mobile-debug.apk"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Get-FileHash -Algorithm SHA256 "$taskBuild/lakomics-mobile-debug.apk"
exit 0
