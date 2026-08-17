$ErrorActionPreference = "Stop"

$Repo = (& wsl.exe wslpath -a $PSScriptRoot).Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($Repo)) {
    throw "Could not resolve the bridge checkout path inside WSL."
}
if ($Repo.Contains('"')) {
    throw "The bridge checkout path cannot contain a double quote."
}
$QuotedRepo = '"' + $Repo + '"'
Start-Process -FilePath "wsl.exe" -ArgumentList @("--cd", $QuotedRepo, "bash", "start-bridge-host.sh") -WindowStyle Hidden
Write-Output "started"
