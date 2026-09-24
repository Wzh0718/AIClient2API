param(
    [Parameter(Mandatory)][string]$Image,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$Revision,
    [Parameter(Mandatory)][ValidatePattern('^[a-zA-Z0-9_.@-]+$')][string]$Target,
    [Parameter(Mandatory)][ValidatePattern('^[a-zA-Z0-9_.-]+$')][string]$ExpectedHost,
    [Parameter(Mandatory)][string]$OutputDirectory,
    [Parameter(Mandatory)][ValidatePattern('^/[a-zA-Z0-9_./-]+$')][string]$RemoteDirectory,
    [string]$IdentityFile,
    [switch]$Apply
)
$ErrorActionPreference = 'Stop'
if ($RemoteDirectory -eq '/' -or ($RemoteDirectory -split '/') -contains '..') { throw 'Unsafe remote artifact directory' }
$stageTimes = [ordered]@{}
$sshOptions = @('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15')
if ($IdentityFile) { $sshOptions += @('-i', $IdentityFile) }
function Invoke-Stage([string]$Name, [scriptblock]$Action) {
    $watch = [Diagnostics.Stopwatch]::StartNew()
    & $Action
    if ($LASTEXITCODE -ne 0) { throw "Stage failed: $Name (exit $LASTEXITCODE)" }
    $stageTimes[$Name] = [math]::Round($watch.Elapsed.TotalSeconds, 3)
}
$actual = & docker image inspect --format '{{ index .Config.Labels "yyn.base_commit" }}' $Image
if ($LASTEXITCODE -ne 0 -or $actual -ne $Revision) { throw 'Image revision mismatch' }
$imageId = & docker image inspect --format '{{.Id}}' $Image
if ($LASTEXITCODE -ne 0) { throw 'Image inspection failed' }
$remoteHostName = & ssh @sshOptions $Target hostname
if ($LASTEXITCODE -ne 0 -or $remoteHostName -ne $ExpectedHost) { throw 'Remote hostname mismatch' }
if (-not $Apply) {
    [ordered]@{ dryRun = $true; revision = $Revision; imageId = $imageId; stages = @('export', 'compress', 'transfer', 'checksum', 'load', 'verify') } | ConvertTo-Json
    return
}
$outputRoot = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
$tarPath = Join-Path $outputRoot "$Revision.tar"
$gzipPath = "$tarPath.gz"
if ((Test-Path -LiteralPath $tarPath) -or (Test-Path -LiteralPath $gzipPath)) { throw 'Artifact already exists; use a new release output directory' }
$remoteArchive = "$RemoteDirectory/$Revision.tar.gz"
# Preserve the release tag in the archive; verify identity again in case it moved.
Invoke-Stage 'export' { & docker save --output $tarPath $Image }
$afterExportId = & docker image inspect --format '{{.Id}}' $Image
if ($LASTEXITCODE -ne 0 -or $afterExportId -ne $imageId) { throw 'Image tag moved during export' }
$watch = [Diagnostics.Stopwatch]::StartNew()
$inputStream = [IO.File]::OpenRead($tarPath)
$outputStream = [IO.File]::Create($gzipPath)
try {
    $gzipStream = [IO.Compression.GZipStream]::new($outputStream, [IO.Compression.CompressionLevel]::Fastest, $true)
    try { $inputStream.CopyTo($gzipStream) } finally { $gzipStream.Dispose() }
} finally { $inputStream.Dispose(); $outputStream.Dispose() }
$stageTimes['compress'] = [math]::Round($watch.Elapsed.TotalSeconds, 3)
$hash = (Get-FileHash -LiteralPath $gzipPath -Algorithm SHA256).Hash.ToLowerInvariant()
Invoke-Stage 'remote-directory' { & ssh @sshOptions $Target "mkdir -p '$RemoteDirectory' && chmod 700 '$RemoteDirectory'" }
Invoke-Stage 'transfer' { & scp @sshOptions $gzipPath "${Target}:$remoteArchive" }
$watch.Restart()
$remoteHash = & ssh @sshOptions $Target "sha256sum '$remoteArchive'"
if ($LASTEXITCODE -ne 0 -or ($remoteHash -split '\s+')[0] -ne $hash) { throw 'Transferred archive checksum mismatch; refusing load' }
$stageTimes['checksum'] = [math]::Round($watch.Elapsed.TotalSeconds, 3)
Invoke-Stage 'load' { & ssh @sshOptions $Target "docker load -i '$remoteArchive'" }
$remoteImageId = & ssh @sshOptions $Target "docker image inspect --format '{{.Id}}' '$imageId'"
if ($LASTEXITCODE -ne 0 -or $remoteImageId -ne $imageId) { throw 'Remote image identity mismatch' }
$report = [ordered]@{ revision = $Revision; imageId = $imageId; sha256 = $hash; bytes = (Get-Item -LiteralPath $gzipPath).Length; timings = $stageTimes; status = 'loaded'; containerCutover = 'not_run' }
$report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $outputRoot 'delivery.json') -Encoding utf8
# Only this invocation's uncompressed transfer file is removed. Keep the checked
# archive/report until deployment succeeds; remote cleanup is a separate action.
if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($tarPath)) -ne $outputRoot) { throw 'Unsafe temporary artifact path' }
Remove-Item -LiteralPath $tarPath
if (Test-Path -LiteralPath $tarPath) { throw 'Temporary archive cleanup failed' }
$report | ConvertTo-Json -Depth 5
