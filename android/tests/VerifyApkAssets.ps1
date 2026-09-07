param(
 [Parameter(Mandatory=$true)][string]$ApkPath,
 [Parameter(Mandatory=$true)][string]$AssetsRoot
)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$assetPrefix=[IO.Path]::GetFullPath($AssetsRoot).TrimEnd([char[]]'/\')+[IO.Path]::DirectorySeparatorChar
$archive=[IO.Compression.ZipFile]::OpenRead([IO.Path]::GetFullPath($ApkPath))
try {
 $names=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
 foreach($entry in $archive.Entries) {
  if($entry.FullName.Contains('\')) { throw "APK contains a Windows path separator: $($entry.FullName)" }
  if(-not $names.Add($entry.FullName)) { throw "Duplicate APK entry: $($entry.FullName)" }
 }
 $files=@(Get-ChildItem -LiteralPath $AssetsRoot -Recurse -File)
 foreach($file in $files) {
  $expected='assets/'+$file.FullName.Substring($assetPrefix.Length).Replace('\','/')
  $entry=$archive.GetEntry($expected)
  if($null -eq $entry -or $entry.Length -ne $file.Length) { throw "Missing or truncated bundled asset: $expected" }
 }
 $index=$archive.GetEntry('assets/index.html')
 if($null -eq $index) { throw 'Missing APK entry page.' }
 $reader=[IO.StreamReader]::new($index.Open())
 try { $html=$reader.ReadToEnd() } finally { $reader.Dispose() }
 foreach($match in [regex]::Matches($html,'(?:src|href)="(?:\./)?([^"?#]+)"')) {
  $reference='assets/'+$match.Groups[1].Value
  if(-not $names.Contains($reference)) { throw "Entry page references a missing APK asset: $reference" }
 }
 Write-Output "APK assets: $($files.Count) Android paths and entry-page references verified."
} finally { $archive.Dispose() }
