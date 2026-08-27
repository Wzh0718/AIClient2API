$ErrorActionPreference = 'Stop'
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('aiclient2api-build-13b0b026-' + [guid]::NewGuid().ToString('N'))
$archive = Join-Path ([System.IO.Path]::GetTempPath()) ('aiclient2api-13b0b026-' + [guid]::NewGuid().ToString('N') + '.tar')
New-Item -ItemType Directory -Path $tmp | Out-Null
git archive --format=tar --output=$archive 13b0b026
tar -xf $archive -C $tmp
$commit = (git rev-parse 13b0b026).Trim()
$buildDate = (Get-Date).ToUniversalTime().ToString('o')
docker build --build-arg "APP_REVISION=$commit" --build-arg "APP_BUILD_DATE=$buildDate" --build-arg 'GOPROXY=https://goproxy.cn,direct' --label "yyn.base_commit=$commit" --label 'yyn.build_source=git-archive' --label "yyn.build_date=$buildDate" -t 'aiclient2api:custom-13b0b026-20260827' $tmp
$actual = (docker image inspect --format '{{ index .Config.Labels "yyn.base_commit" }}' 'aiclient2api:custom-13b0b026-20260827').Trim()
if ($actual -ne $commit) { throw "image revision mismatch: expected=$commit actual=$actual" }
Write-Output "built and verified $actual"
Write-Output "BUILD_CONTEXT=$tmp"
Write-Output "ARCHIVE=$archive"
