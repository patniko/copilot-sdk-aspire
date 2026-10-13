[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$RuntimeRepository,
    [Parameter(Mandatory)][string]$HostingRepository,
    [Parameter(Mandatory)][string]$MxcRepository,
    [Parameter(Mandatory)][string]$OutputDirectory,
    [ValidateSet('fast', 'release')][string]$Configuration = 'fast',
    [ValidateRange(1, 16)][int]$Jobs = 4,
    [string]$NpmRegistry = 'https://registry.npmjs.org/'
)
$ErrorActionPreference = 'Stop'

function Run([string]$Program, [string[]]$Arguments) {
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Program failed with exit code $LASTEXITCODE." }
}
function Revision([string]$Repository) {
    $revision = & git -C $Repository rev-parse HEAD
    if ($LASTEXITCODE -ne 0) { throw "Not a Git repository: $Repository" }
    $dirty = & git -C $Repository status --porcelain --untracked-files=no
    if ($LASTEXITCODE -ne 0 -or $dirty) { throw "Commit tracked source changes before packaging: $Repository" }
    return $revision.Trim()
}

$runtime = (Resolve-Path -LiteralPath $RuntimeRepository).Path
$hosting = (Resolve-Path -LiteralPath $HostingRepository).Path
$mxc = (Resolve-Path -LiteralPath $MxcRepository).Path
$output = [IO.Path]::GetFullPath($OutputDirectory)
if ((Test-Path -LiteralPath $output) -and (Get-ChildItem -LiteralPath $output -Force | Select-Object -First 1)) {
    throw 'OutputDirectory must be absent or empty; never overwrite a potentially loaded native bundle.'
}
$revisions = @{ runtime = (Revision $runtime); hosting = (Revision $hosting); mxc = (Revision $mxc) }
$cargo = Get-Content -LiteralPath (Join-Path $runtime 'Cargo.toml') -Raw
if ($cargo -notmatch 'mxc-sdk\s*=\s*\{[^\r\n]*rev\s*=\s*"([0-9a-f]{40})"' -or $Matches[1] -ne $revisions.mxc) {
    throw 'MxcRepository must be at the exact revision pinned by the runtime Cargo.toml.'
}
if ($cargo -notmatch 'copilotd-hosting\s*=\s*\{[^\r\n]*rev\s*=\s*"([0-9a-f]{40})"') {
    throw 'Cannot identify the pinned hosting dependency.'
}
Run git @('-C', $hosting, 'diff', '--exit-code', $Matches[1], 'HEAD', '--', 'Cargo.toml', ':(glob)**/Cargo.toml')
$platform = & docker version --format '{{.Server.Os}}/{{.Server.Arch}}'
if ($LASTEXITCODE -ne 0 -or $platform -notin @('linux/arm64', 'linux/amd64')) { throw 'A native Linux Docker engine is required.' }
$repo = Split-Path $PSScriptRoot -Parent
$context = Join-Path $repo ".runtime-artifacts\build-input-$([Guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $context | Out-Null
try {
    foreach ($source in @(@($runtime, 'runtime'), @($hosting, 'hosting'), @($mxc, 'mxc'))) {
        Run git @('-C', $source[0], 'archive', '--format=tar', "--output=$(Join-Path $context ($source[1] + '.tar'))", 'HEAD')
    }
    Push-Location (Join-Path $runtime 'src\sdk\nodejs')
    try {
        Run npm @('run', 'build')
        $packed = & npm pack --ignore-scripts --json --pack-destination $context
        if ($LASTEXITCODE -ne 0) { throw 'The local SDK could not be packed.' }
        $package = @($packed | ConvertFrom-Json)[0]
        Move-Item -LiteralPath (Join-Path $context $package.filename) -Destination (Join-Path $context 'sdk.tgz')
    } finally { Pop-Location }
    foreach ($name in @('prepare-runtime-overrides.mjs', 'qualify-hybrid-runtime.mjs')) {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $context $name)
    }
    Copy-Item -LiteralPath (Join-Path $repo 'tests\runtime\filesystem.ts') -Destination (Join-Path $context 'filesystem.ts')
    $inputs = @{}
    foreach ($name in @('runtime.tar', 'hosting.tar', 'mxc.tar', 'sdk.tgz')) {
        $inputs[$name] = (Get-FileHash -LiteralPath (Join-Path $context $name) -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    @{
        schemaVersion = 1; revisions = $revisions; platform = $platform.Trim()
        configuration = $Configuration; inputs = $inputs
    } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $context 'provenance.json') -Encoding utf8NoBOM
    Run docker @('buildx', 'build', '--progress=plain', '--file', (Join-Path $PSScriptRoot 'HybridRuntime.Dockerfile'),
        '--build-arg', "NPM_REGISTRY=$NpmRegistry", '--build-arg', "CONFIGURATION=$Configuration",
        '--build-arg', "BUILD_JOBS=$Jobs", '--output', "type=local,dest=$output", $context)
    foreach ($line in Get-Content -LiteralPath (Join-Path $output 'SHA256SUMS')) {
        if ($line -notmatch '^([0-9a-f]{64})  (copilot-runtime|runtime.node|sdk.tgz|provenance.json)$') { throw 'Invalid bundle checksum manifest.' }
        if ((Get-FileHash -LiteralPath (Join-Path $output $Matches[2]) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Matches[1]) {
            throw 'Exported bundle checksum mismatch.'
        }
    }
    Write-Output "Qualified $platform bundle: $output"
} finally {
    Remove-Item -LiteralPath $context -Recurse -Force
}
