$ErrorActionPreference = 'Stop'
$auditRoot = Join-Path $PSScriptRoot 'evidence\public'
New-Item -ItemType Directory -Path $auditRoot -Force | Out-Null
$auditTargets = @(
    @{ Name = 'portal'; Uri = 'https://home.agentelite.com/Login' },
    @{ Name = 'marketing'; Uri = 'https://agentelite.com/' },
    @{ Name = 'knowledge-base'; Uri = 'https://help.agentelite.com/' }
)
foreach ($auditTarget in $auditTargets) {
    try {
        $auditResponse = Invoke-WebRequest -Uri $auditTarget.Uri -UseBasicParsing -TimeoutSec 30
        $auditHtml = $auditResponse.Content
        $auditScripts = @([regex]::Matches($auditHtml, '<script[^>]+src=["'']([^"'']+)["'']', 'IgnoreCase') | ForEach-Object { [System.Net.WebUtility]::HtmlDecode($_.Groups[1].Value) })
        $auditStyles = @([regex]::Matches($auditHtml, '<link[^>]+href=["'']([^"'']+)["'']', 'IgnoreCase') | ForEach-Object { [System.Net.WebUtility]::HtmlDecode($_.Groups[1].Value) })
        $auditGenerators = @([regex]::Matches($auditHtml, '<meta[^>]+name=["'']generator["''][^>]*>', 'IgnoreCase') | ForEach-Object { $_.Value })
        $auditHeaders = [ordered]@{}
        foreach ($auditHeader in @('Server', 'Content-Type', 'Strict-Transport-Security', 'X-Content-Type-Options', 'X-Frame-Options', 'Content-Security-Policy', 'Cache-Control', 'X-Powered-By')) {
            if ($auditResponse.Headers[$auditHeader]) { $auditHeaders[$auditHeader] = $auditResponse.Headers[$auditHeader] }
        }
        $auditEvidence = [ordered]@{
            Source = $auditTarget.Uri
            ObservedAtUtc = [DateTime]::UtcNow.ToString('o')
            FinalOriginAndPath = $auditResponse.BaseResponse.ResponseUri.GetLeftPart([System.UriPartial]::Path)
            HttpStatus = [int]$auditResponse.StatusCode
            Headers = $auditHeaders
            ScriptSources = $auditScripts
            LinkedAssets = $auditStyles
            GeneratorMetadata = $auditGenerators
            Scope = 'Public unsigned response. No browser cookies, request secrets, or authenticated data collected.'
        }
        $auditEvidence | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $auditRoot ($auditTarget.Name + '-asset-evidence.json')) -Encoding UTF8
        [pscustomobject]@{ Name = $auditTarget.Name; Status = $auditEvidence.HttpStatus; Scripts = $auditScripts.Count; Generator = ($auditGenerators -join ' ') }
    } catch {
        [pscustomobject]@{ Name = $auditTarget.Name; Error = $_.Exception.Message }
    }
}
Resolve-DnsName -Name 'home.agentelite.com' -Type A | Select-Object Name, Type, NameHost, IPAddress | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $auditRoot 'portal-dns-evidence.json') -Encoding UTF8
