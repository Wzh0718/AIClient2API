param(
    [Parameter(Mandatory)][string]$Profile,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$Revision,
    [ValidatePattern('^[a-zA-Z0-9_.:/-]+$')][string]$Image,
    [ValidateSet('Prepare','Deploy')][string]$Mode = 'Prepare',
    [ValidateRange(0,180)][int]$MaxDrainSeconds = 20,
    [ValidateRange(0,10)][int]$MaxForcedInFlight = 0,
    [switch]$Apply,
    [switch]$Maintenance
)
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$profilePath = [IO.Path]::GetFullPath($Profile)
$config = Get-Content -LiteralPath $profilePath -Raw | ConvertFrom-Json
$remotePathRule = '^/[a-zA-Z0-9_./-]+$'
foreach ($field in @('releaseBase','previousSpec','previousState','remoteToolsDir')) {
    if ($config.$field -notmatch $remotePathRule -or ($config.$field -split '/') -contains '..') {
        throw "Unsafe profile path: $field"
    }
}
if ($config.target -notmatch '^[a-zA-Z0-9_.@-]+$' -or $config.expectedHost -notmatch '^[a-zA-Z0-9_.-]+$') {
    throw 'Invalid target identity in profile'
}
if ($Mode -eq 'Deploy' -and -not $Maintenance) { throw 'Deploy requires -Maintenance for a bounded public API 503' }
$shortRevision = $Revision.Substring(0,7)
if (-not $Image) { $Image = "aiclient2api:customized-branch-$shortRevision-$(Get-Date -Format yyyyMMdd)" }
$runFile = "$profilePath.run.json"
$record = $null
if (Test-Path -LiteralPath $runFile) {
    $record = Get-Content -LiteralPath $runFile -Raw | ConvertFrom-Json
    if ($record.revision -ne $Revision) { throw 'Another release record exists for this profile' }
    if ($Image -ne $record.image) { throw 'Image differs from recorded release attempt' }
}
$sshOptions = @('-o','BatchMode=yes','-o','ConnectTimeout=15')
if ($config.identityFile) { $sshOptions += @('-i',[string]$config.identityFile) }
function Invoke-Remote([string[]]$Command) {
    $parts = foreach ($item in $Command) {
        if ($item -notmatch '^[a-zA-Z0-9_./:@-]+$') { throw 'Unsafe remote command argument' }
        "'$item'"
    }
    $output = @(& ssh @sshOptions $config.target ($parts -join ' ') | ForEach-Object {
        if ($_ -like 'stage=*') { Write-Host $_ } else { $_ }
    })
    if ($LASTEXITCODE -ne 0) { throw 'Remote release step failed; inspect the preserved release state' }
    return $output
}
function Save-Run($state) {
    $state | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $runFile -Encoding utf8
}
$hostName = Invoke-Remote @('hostname')
if ($hostName -ne $config.expectedHost) { throw 'Remote hostname changed' }
if (-not $Apply) {
    [ordered]@{dryRun=$true;mode=$Mode;revision=$Revision;image=$image;host=$hostName;
        savedPhase=if($record){$record.phase}else{'none'};maintenance=$Maintenance.IsPresent} | ConvertTo-Json
    return
}
$timer = [Diagnostics.Stopwatch]::StartNew()
$targetCommit = & git -C $repoRoot rev-parse "$Revision^{commit}"
if ($LASTEXITCODE -ne 0 -or $targetCommit -ne $Revision) { throw 'Pinned release revision is unavailable locally' }
if ((& git -C $repoRoot status --porcelain).Count -ne 0) { throw 'Working tree is not clean' }
$actualImageRevision = & docker image inspect --format '{{index .Config.Labels "yyn.base_commit"}}' $image 2>$null
if ($LASTEXITCODE -ne 0) {
    $bash = 'D:\Git\bin\bash.exe'
    if (-not (Test-Path -LiteralPath $bash)) { throw 'Git for Windows Bash is unavailable' }
    $buildDirectory = "outputs/ops-release-$shortRevision"
    & $bash -lc "RELEASE_BUILD_DIR=$buildDirectory bash scripts/ops/build-image.sh $Revision $image"
    if ($LASTEXITCODE -ne 0) { throw 'Image build failed' }
    $actualImageRevision = & docker image inspect --format '{{index .Config.Labels "yyn.base_commit"}}' $image
}
if ($actualImageRevision -ne $Revision) { throw 'Local image revision mismatch' }
$localImageId = & docker image inspect --format '{{.Id}}' $image
if ($LASTEXITCODE -ne 0) { throw 'Local image identity unavailable' }
$localActive = [string]$config.localActiveContainer
if (-not $localActive) { $localActive = 'aiclient2api' }
$localRevision = & docker exec $localActive cat /app/REVISION
if ($LASTEXITCODE -ne 0 -or $localRevision -ne $Revision) {
    throw 'Local active container has not been updated and verified for this revision'
}
$localInspect = (& docker inspect $localActive | ConvertFrom-Json)[0]
if ($LASTEXITCODE -ne 0 -or $localInspect.State.Health.Status -ne 'healthy') {
    throw 'Local active container is not healthy'
}
$apiBindings = @($localInspect.HostConfig.PortBindings.'3000/tcp')
if ($apiBindings.Count -ne 1 -or [int]$apiBindings[0].HostPort -lt 1) {
    throw 'Cannot identify the active local API port'
}
$localRuntimeUrl = "http://127.0.0.1:$($apiBindings[0].HostPort)/runtime/health"
$localRuntime = Invoke-RestMethod -Uri $localRuntimeUrl -TimeoutSec 10
if ($localRuntime.status -ne 'healthy' -or $localRuntime.providerConfig.pendingWorkerCount -ne 0 -or
    $localRuntime.readyWorkers -ne ($localRuntime.executionWorkers + 1)) { throw 'Local runtime verification failed' }
$remoteImageId = & ssh @sshOptions $config.target "docker image inspect --format '{{.Id}}' '$image'" 2>$null
if ($LASTEXITCODE -ne 0) {
    $artifactDir = Join-Path ([IO.Path]::GetDirectoryName($profilePath)) "delivery-$shortRevision"
    & (Join-Path $PSScriptRoot 'ship-image.ps1') -Image $image -Revision $Revision -Target $config.target `
        -ExpectedHost $config.expectedHost -IdentityFile $config.identityFile -OutputDirectory $artifactDir `
        -RemoteDirectory "$($config.releaseBase)/artifacts" -Apply | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Image delivery failed' }
} elseif ($remoteImageId -ne $localImageId) {
    throw 'Remote image tag points to another image ID'
}
$toolsDir = [string]$config.remoteToolsDir
Invoke-Remote @('mkdir','-p',$toolsDir) | Out-Null
Invoke-Remote @('chmod','700',$toolsDir) | Out-Null
foreach ($name in @('release.py','release_backup.py','release_maintenance.py','quick-release.py','prepare-release-spec.py','nginx_maintenance_precheck.py')) {
    & scp @sshOptions (Join-Path $PSScriptRoot $name) "$($config.target):$toolsDir/$name"
    if ($LASTEXITCODE -ne 0) { throw "Tool transfer failed: $name" }
}
if (-not $record) {
    $runId = "rel-$shortRevision-$(Get-Date -Format yyyyMMddHHmmss)"
    $root = "$($config.releaseBase)/$runId"
    $created = Invoke-Remote @('python3',"$toolsDir/prepare-release-spec.py",'--previous-spec',$config.previousSpec,
        '--previous-state',$config.previousState,'--output-root',$root,'--revision',$Revision,'--image',$image,'--apply')
    $details = ($created -join "`n") | ConvertFrom-Json
    $record = [ordered]@{revision=$Revision;image=$image;spec=$details.newSpec;
        stateDir=$details.newStateDir;phase='profile_created';startedAt=(Get-Date).ToString('o')}
    Save-Run $record
}
$phase = if ($Mode -eq 'Deploy') { 'all' } else { 'prepare' }
$command = @('python3',"$toolsDir/quick-release.py",'--spec',$record.spec,
    '--state-dir',$record.stateDir,'--phase',$phase,'--apply')
if ($Mode -eq 'Deploy') { $command += '--maintenance' }
if ($Mode -eq 'Deploy') { $command += @('--drain-timeout',[string]$MaxDrainSeconds) }
if ($Mode -eq 'Deploy' -and $MaxForcedInFlight -gt 0) {
    $command += @('--max-forced-in-flight',[string]$MaxForcedInFlight)
}
$result = Invoke-Remote $command
$outcome = ($result -join "`n") | ConvertFrom-Json
$record.phase = $outcome.phase
$elapsedSeconds = [math]::Round($timer.Elapsed.TotalSeconds,2)
if ($record -is [System.Collections.IDictionary]) {
    $record['elapsedSeconds'] = $elapsedSeconds
} else {
    $record | Add-Member -NotePropertyName elapsedSeconds -NotePropertyValue $elapsedSeconds -Force
}
Save-Run $record
if ($outcome.phase -eq 'complete') {
    $config.previousSpec = $record.spec
    $config.previousState = $record.stateDir
    $config | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $profilePath -Encoding utf8
}
[ordered]@{phase=$outcome.phase;revision=$Revision;elapsedSeconds=$record.elapsedSeconds;
    interruptionSeconds=$outcome.interruptionSeconds;
    possibleInterruptedRequestsUpperBound=$outcome.possibleInterruptedRequestsUpperBound;
    report=$outcome.report;stateDir=$record.stateDir} | ConvertTo-Json -Depth 8
