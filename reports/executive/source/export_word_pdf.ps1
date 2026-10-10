$ErrorActionPreference = 'Stop'
$executiveRoot = Split-Path -Parent $PSScriptRoot
$documentPath = Join-Path $executiveRoot 'Agent8lite-Application-Requirements-and-Features-2026-10-10.docx'
$pdfPath = [System.IO.Path]::ChangeExtension($documentPath, '.pdf')
$wordApplication = New-Object -ComObject Word.Application
$wordApplication.Visible = $false
$wordApplication.DisplayAlerts = 0
$wordApplication.AutomationSecurity = 3
$openedDocument = $null
try {
    $openedDocument = $wordApplication.Documents.Open($documentPath, $false, $true)
    $openedDocument.Repaginate()
    $openedDocument.ExportAsFixedFormat($pdfPath, 17, $false, 0, 0, 1, 1, 0, $true, $true, 1, $true, $true, $false)
    Write-Output "Word PDF export completed; pages $($openedDocument.ComputeStatistics(2))"
} finally {
    if ($null -ne $openedDocument) { $openedDocument.Close(0) }
    $wordApplication.Quit()
    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($wordApplication) | Out-Null
}
