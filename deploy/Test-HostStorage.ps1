param(
    [Parameter(Mandatory)][string]$ResourceGroup,
    [Parameter(Mandatory)][string]$Subscription,
    [Parameter(Mandatory)][ValidateSet('write', 'read', 'cleanup')][string]$Phase,
    [Parameter(Mandatory)][guid]$ProbeId
)
$ErrorActionPreference = 'Stop'
$command = "python3 /opt/verify-host-storage.py $Phase $ProbeId"
& az containerapp exec --subscription $Subscription --resource-group $ResourceGroup --name agent-host --command $command |
    Tee-Object -Variable output
if ($LASTEXITCODE -ne 0) { throw "Azure host storage probe failed ($LASTEXITCODE)." }
$expected = '"phase": "' + $Phase + '", "result": "passed", "probeId": "' + $ProbeId + '"'
if (-not ($output -join "`n").Contains($expected)) { throw 'The remote probe did not report success for this probe ID.' }
