#requires -Version 5.1
[CmdletBinding()]
param([switch]$CheckOnly, [switch]$LibraryOnly)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function ConvertTo-WindowsArgument {
    param([AllowEmptyString()][string]$Value)
    if ($Value -and $Value -notmatch '[\s"]') { return $Value }
    $result = New-Object System.Text.StringBuilder
    [void]$result.Append([char]34)
    $slashes = 0
    foreach ($character in $Value.ToCharArray()) {
        if ($character -eq [char]92) { $slashes++; continue }
        if ($character -eq [char]34) {
            [void]$result.Append(([string][char]92) * (2 * $slashes + 1))
        } else { [void]$result.Append(([string][char]92) * $slashes) }
        [void]$result.Append($character)
        $slashes = 0
    }
    [void]$result.Append(([string][char]92) * (2 * $slashes))
    [void]$result.Append([char]34)
    return $result.ToString()
}

function Get-NodeArchiveHash {
    param([string]$Manifest, [string]$Filename)
    $entries = @($Manifest -split '\r?\n' | Where-Object {
        $_ -match ('^([0-9a-fA-F]{64})\s+\*?' + [regex]::Escape($Filename) + '$')
    })
    if ($entries.Count -ne 1) { throw 'bootstrap_node_checksum_missing_or_ambiguous' }
    return ($entries[0] -split '\s+')[0].ToLowerInvariant()
}

function Get-InstallerOutcome {
    param([int]$ExitCode)
    if ($ExitCode -eq 0) { return 'complete' }
    if ($ExitCode -in @(3010, 1641)) { return 'restart' }
    return 'failed'
}

function Assert-WorkspacePath {
    param([string]$Root, [string]$Target)
    $base = [IO.Path]::GetFullPath($Root).TrimEnd([char]92, [char]47)
    $absolute = [IO.Path]::GetFullPath($Target)
    if (-not $absolute.StartsWith($base + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'bootstrap_path_outside_workspace'
    }
    $ancestor = $absolute
    while ($ancestor -and $ancestor.StartsWith($base, [StringComparison]::OrdinalIgnoreCase)) {
        if (Test-Path -LiteralPath $ancestor) {
            $item = Get-Item -LiteralPath $ancestor -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'bootstrap_reparse_path_denied'
            }
        }
        if ($ancestor -eq $base) { break }
        $ancestor = [IO.Path]::GetDirectoryName($ancestor)
    }
    return $absolute
}

function Get-BootstrapPlan {
    param([string]$Root)
    $rootPath = [IO.Path]::GetFullPath($Root).TrimEnd([char]92, [char]47)
    foreach ($required in @('package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.node-version',
        'compose.yaml', 'packages/db/migrate.ts', 'packages/db/seed.ts', 'scripts/local-control-identities.mjs')) {
        if (-not (Test-Path -LiteralPath (Join-Path $rootPath $required) -PathType Leaf)) {
            throw ('Extract the entire project first. Missing ' + $required)
        }
    }
    $nodeVersion = (Get-Content -LiteralPath (Join-Path $rootPath '.node-version') -Raw).Trim()
    $package = Get-Content -LiteralPath (Join-Path $rootPath 'package.json') -Raw | ConvertFrom-Json
    if ($nodeVersion -ne '24.19.0' -or $package.packageManager -ne 'pnpm@11.25.0') {
        throw 'Runtime pins changed. The integration owner must review/update this bootstrapper.'
    }
    $canonical = $rootPath.Replace('\', '/').ToLowerInvariant()
    $hash = [Security.Cryptography.SHA256]::Create()
    try { $digest = $hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($canonical)) } finally { $hash.Dispose() }
    $key = ([BitConverter]::ToString($digest)).Replace('-', '').ToLowerInvariant().Substring(0, 16)
    return [pscustomobject]@{
        Root = $rootPath
        NodeVersion = $nodeVersion
        PnpmVersion = '11.25.0'
        NodeArchiveHash = '57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73'
        Project = 'agent8lite-' + $key
        Directory = Assert-WorkspacePath $rootPath (Join-Path $rootPath '.local/bootstrap')
    }
}

function New-SyntheticEnvironment {
    param($Plan, [string]$NodeDirectory = '')
    $allowed = @('systemroot', 'windir', 'path', 'temp', 'tmp', 'userprofile', 'appdata',
        'localappdata', 'home', 'lang', 'lc_all', 'tz', 'comspec', 'pathext',
        'number_of_processors', 'processor_architecture', 'processor_architew6432',
        'http_proxy', 'https_proxy', 'no_proxy', 'node_extra_ca_certs')
    $result = @{}
    foreach ($entry in [Environment]::GetEnvironmentVariables('Process').GetEnumerator()) {
        if ($entry.Key.ToLowerInvariant() -in $allowed) { $result[[string]$entry.Key] = [string]$entry.Value }
    }
    $configuration = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'synthetic-environment.json') -Raw | ConvertFrom-Json
    foreach ($property in $configuration.PSObject.Properties) { $result[$property.Name] = [string]$property.Value }
    $result['PRIVATE_OBJECT_DIRECTORY'] = Join-Path $Plan.Root '.local/private-objects'
    $result['npm_config_userconfig'] = Join-Path $Plan.Directory 'npmrc'
    $result['npm_config_registry'] = 'https://registry.npmjs.org'
    if ($NodeDirectory) { $result['PATH'] = $NodeDirectory + ';' + $result['PATH'] }
    return $result
}

function Invoke-BootstrapTool {
    param([string]$Executable, [string[]]$Arguments, [hashtable]$Environment,
        [string]$Directory, [string]$Label, [switch]$Capture, [switch]$AllowFailure,
        [switch]$Interactive, [int]$TimeoutSeconds = 1200)
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $Executable
    $info.Arguments = ($Arguments | ForEach-Object { ConvertTo-WindowsArgument $_ }) -join ' '
    $info.WorkingDirectory = $Directory
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $Capture.IsPresent
    $info.EnvironmentVariables.Clear()
    foreach ($entry in $Environment.GetEnumerator()) { $info.EnvironmentVariables[$entry.Key] = $entry.Value }
    if ($Capture) { $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true }
    $process = New-Object Diagnostics.Process
    $toolJob = $null
    $wrapperNode = $Environment['AGENT8LITE_BOOTSTRAP_NODE']
    if ($wrapperNode) {
        Initialize-BootstrapJobType
        $info.FileName = $wrapperNode
        $info.Arguments = ConvertTo-WindowsArgument (Join-Path $PSScriptRoot 'tool.mjs')
        $info.RedirectStandardInput = $true
    }
    $process.StartInfo = $info
    try {
        if (-not $process.Start()) { throw ($Label + ' could not start.') }
        if ($wrapperNode) {
            $toolJob = New-Object Agent8liteBootstrapJob
            $toolJob.Assign($process.Handle)
            $command = @{ executable = $Executable; arguments = @($Arguments); directory = $Directory;
                interactive = $Interactive.IsPresent } |
                ConvertTo-Json -Compress -Depth 4
            $process.StandardInput.WriteLine($command)
            $process.StandardInput.Close()
        }
        if ($Capture) { $outTask = $process.StandardOutput.ReadToEndAsync(); $errorTask = $process.StandardError.ReadToEndAsync() }
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            $process.Kill()
            throw ($Label + ' timed out. Close any installer prompt and click again.')
        }
        $code = $process.ExitCode
        $text = ''
        if ($Capture) {
            $text = $outTask.GetAwaiter().GetResult()
            [void]$errorTask.GetAwaiter().GetResult()
            if ($text.Length -gt 1048576) { throw ($Label + ' returned excessive output.') }
        }
        if ($code -ne 0 -and -not $AllowFailure) {
            throw ($Label + ' failed (exit ' + $code + '). Resolve the displayed error and click again.')
        }
        return [pscustomobject]@{ ExitCode = $code; Text = $text }
    } finally {
        if ($toolJob) { $toolJob.Dispose() }
        $process.Dispose()
    }
}

function Get-Listeners {
    return @([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() |
        Select-Object -ExpandProperty Port -Unique)
}

function Assert-AppPorts {
    $listeners = @(Get-Listeners)
    foreach ($port in @(3000, 3001)) {
        if ($port -in $listeners) {
            throw ('Port ' + $port + ' is already in use. Close the existing app in its own window, then click again. No process was stopped.')
        }
    }
}

function Find-DockerDesktop {
    foreach ($candidate in @(
        (Join-Path $env:LOCALAPPDATA 'Programs/DockerDesktop/Docker Desktop.exe'),
        (Join-Path $env:ProgramFiles 'Docker/Docker/Docker Desktop.exe'))) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    return $null
}

function Find-DockerCli {
    $command = Get-Command docker.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    foreach ($candidate in @(
        (Join-Path $env:LOCALAPPDATA 'Programs/DockerDesktop/resources/bin/docker.exe'),
        (Join-Path $env:ProgramFiles 'Docker/Docker/resources/bin/docker.exe'))) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    return $null
}

function Save-Phase {
    param($Plan, [string]$Phase)
    @{ phase = $Phase; updatedAt = [DateTime]::UtcNow.ToString('o'); project = $Plan.Project } |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Plan.Directory 'setup-state.json') -Encoding UTF8
}

function Ensure-Node {
    param($Plan, [hashtable]$Environment)
    $tools = Assert-WorkspacePath $Plan.Root (Join-Path $Plan.Directory 'tools')
    $downloads = Assert-WorkspacePath $Plan.Root (Join-Path $Plan.Directory 'downloads')
    [void][IO.Directory]::CreateDirectory($tools)
    [void][IO.Directory]::CreateDirectory($downloads)
    $name = 'node-v' + $Plan.NodeVersion + '-win-x64.zip'
    $archive = Join-Path $downloads $name
    $directory = Join-Path $tools ('node-v' + $Plan.NodeVersion + '-win-x64')
    $executable = Join-Path $directory 'node.exe'
    if (-not (Test-Path -LiteralPath $archive -PathType Leaf)) {
        Write-Host '[1/6] Downloading the pinned portable Node.js runtime...'
        $manifest = Invoke-WebRequest -UseBasicParsing -Uri ('https://nodejs.org/dist/v' + $Plan.NodeVersion + '/SHASUMS256.txt') -TimeoutSec 60
        $publisherHash = Get-NodeArchiveHash ([string]$manifest.Content) $name
        if ($publisherHash -ne $Plan.NodeArchiveHash) { throw 'Node publisher checksum differs from the reviewed pin.' }
        $partial = Assert-WorkspacePath $Plan.Root ($archive + '.partial')
        Invoke-WebRequest -UseBasicParsing -Uri ('https://nodejs.org/dist/v' + $Plan.NodeVersion + '/' + $name) -OutFile $partial -TimeoutSec 300
        if ((Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Plan.NodeArchiveHash) {
            throw 'Node download checksum failed. The partial download will be retried next click.'
        }
        Move-Item -LiteralPath $partial -Destination $archive
    }
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Plan.NodeArchiveHash) {
        throw 'Cached Node archive failed its checksum. Remove only the displayed bootstrap download and retry.'
    }
    if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
        if (Test-Path -LiteralPath $directory) { throw 'Node extraction is incomplete. Move the bootstrap tools folder aside and retry.' }
        $staging = Assert-WorkspacePath $Plan.Root (Join-Path $tools ('unpack-' + [Guid]::NewGuid().ToString('N')))
        [void][IO.Directory]::CreateDirectory($staging)
        # Windows PowerShell 5.1 Expand-Archive cannot reliably handle npm's nested long paths.
        $tar = Join-Path $env:SystemRoot 'System32/tar.exe'
        if (-not (Test-Path -LiteralPath $tar -PathType Leaf)) {
            throw 'Windows built-in tar.exe is missing. Use a supported, updated Windows 10/11 installation.'
        }
        [void](Invoke-BootstrapTool $tar @('-xf', $archive, '-C', $staging) $Environment $Plan.Root 'Node archive extraction' -Capture)
        $source = Assert-WorkspacePath $Plan.Root (Join-Path $staging ('node-v' + $Plan.NodeVersion + '-win-x64'))
        [void](Assert-WorkspacePath $Plan.Root $directory)
        Move-Item -LiteralPath $source -Destination $directory
    }
    # Verify the executable itself against the reviewed archive before executing cached tools.
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($archive)
    try {
        $entry = $zip.GetEntry('node-v' + $Plan.NodeVersion + '-win-x64/node.exe')
        if (-not $entry) { throw 'The verified Node archive has no expected executable.' }
        $stream = $entry.Open()
        $digest = [Security.Cryptography.SHA256]::Create()
        try { $binaryHash = ([BitConverter]::ToString($digest.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
        finally { $stream.Dispose(); $digest.Dispose() }
    } finally { $zip.Dispose() }
    if ((Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash.ToLowerInvariant() -ne $binaryHash) {
        throw 'Cached Node executable differs from its verified archive. Move only the bootstrap tools folder aside and retry.'
    }
    $version = Invoke-BootstrapTool $executable @('--version') $Environment $Plan.Root 'Node verification' -Capture
    if ($version.Text.Trim() -ne ('v' + $Plan.NodeVersion)) { throw 'Portable Node version does not match the repository pin.' }
    return $executable
}

function Ensure-Pnpm {
    param($Plan, [string]$Node, [hashtable]$Environment)
    $prefix = Assert-WorkspacePath $Plan.Root (Join-Path $Plan.Directory 'tools/pnpm')
    $entry = Join-Path $prefix 'node_modules/pnpm/bin/pnpm.mjs'
    $manifest = Join-Path $prefix 'node_modules/pnpm/package.json'
    if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) {
        Write-Host '[2/6] Installing pnpm inside this project...'
        $npm = Join-Path ([IO.Path]::GetDirectoryName($Node)) 'node_modules/npm/bin/npm-cli.js'
        [void](Invoke-BootstrapTool $Node @($npm, 'install', '--prefix', $prefix, '--no-audit', '--no-fund',
            '--ignore-scripts', '--package-lock=false', ('pnpm@' + $Plan.PnpmVersion)) $Environment $Plan.Root 'pnpm installation')
    }
    $installed = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
    if ($installed.version -ne $Plan.PnpmVersion) { throw 'Portable pnpm version differs from the repository pin.' }
    return $entry
}

function Ensure-Docker {
    param($Plan, [hashtable]$Environment)
    $desktop = Find-DockerDesktop
    $cli = Find-DockerCli
    if (-not $cli) {
        Save-Phase $Plan 'docker-install'
        Write-Host '[3/6] Docker Desktop is needed for the local database.'
        Write-Host 'Complete its installer/Windows prompts. Docker will show its own terms.'
        $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
        if (-not $winget) {
            Write-Host 'WinGet is unavailable. Downloading the official signed Docker installer...'
            $installer = Assert-WorkspacePath $Plan.Root (Join-Path $Plan.Directory 'downloads/Docker-Desktop-Installer.exe')
            Invoke-WebRequest -UseBasicParsing -Uri 'https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe' -OutFile $installer -TimeoutSec 600
            $signature = Get-AuthenticodeSignature -LiteralPath $installer
            if ($signature.Status -ne 'Valid') { throw 'Docker installer signature validation failed. No installer was run.' }
            $installed = Invoke-BootstrapTool $installer @('install', '--user') $Environment $Plan.Root 'Docker Desktop installation' -AllowFailure -Interactive
        } else {
            $installed = Invoke-BootstrapTool $winget.Source @('install', '--id', 'Docker.DockerDesktop',
                '--exact', '--source', 'winget', '--interactive') $Environment $Plan.Root 'Docker Desktop installation' -AllowFailure -Interactive
        }
        $outcome = Get-InstallerOutcome $installed.ExitCode
        $desktop = Find-DockerDesktop
        $cli = Find-DockerCli
        if ($outcome -eq 'restart') {
            Save-Phase $Plan 'restart-required'
            throw 'Windows needs a restart. Restart when convenient, then click Start-Agent8lite.cmd again. No automatic restart was requested.'
        }
        if (-not $cli) { throw 'Docker installation is incomplete or was cancelled. Complete its setup and click again.' }
    }
    if ($desktop) {
        Write-Host 'Opening Docker Desktop. Accept its terms and complete any WSL/backend prompts.'
        Start-Process -FilePath $desktop
    }
    $deadline = [DateTime]::UtcNow.AddMinutes(3)
    do {
        $contexts = Invoke-BootstrapTool $cli @('context', 'ls', '--format', '{{.Name}}') $Environment $Plan.Root 'Docker context inspection' -Capture -AllowFailure -TimeoutSeconds 10
        foreach ($context in @($contexts.Text -split '\r?\n' | Where-Object { $_ -in @('desktop-linux', 'default') })) {
            $inspection = Invoke-BootstrapTool $cli @('context', 'inspect', $context) $Environment $Plan.Root 'Docker endpoint inspection' -Capture -AllowFailure -TimeoutSeconds 10
            if ($inspection.ExitCode -ne 0) { continue }
            try {
                $metadata = @($inspection.Text | ConvertFrom-Json)
                $endpoint = $metadata[0].Endpoints.docker.Host
                if ($endpoint -notin @('npipe:////./pipe/dockerDesktopLinuxEngine', 'npipe:////./pipe/docker_engine')) { continue }
                $server = Invoke-BootstrapTool $cli @('--context', $context, 'info', '--format', '{{.OSType}}') $Environment $Plan.Root 'Docker readiness' -Capture -AllowFailure -TimeoutSeconds 10
                if ($server.ExitCode -eq 0 -and $server.Text.Trim() -eq 'linux') {
                    $compose = Invoke-BootstrapTool $cli @('--context', $context, 'compose', 'version') $Environment $Plan.Root 'Docker Compose verification' -Capture
                    return [pscustomobject]@{ Cli = $cli; Context = $context }
                }
            } catch { }
        }
        Start-Sleep -Seconds 3
    } while ([DateTime]::UtcNow -lt $deadline)
    Save-Phase $Plan 'docker-needs-attention'
    throw 'Docker is not ready with a local Linux engine. Complete its WSL/virtualization setup, restart if requested, and click again. Existing services were preserved.'
}

function Get-ComposeArguments {
    param($Plan, $Docker)
    return @('--context', $Docker.Context, 'compose', '--project-name', $Plan.Project,
        '--file', (Join-Path $Plan.Root 'compose.yaml'))
}

function Assert-DatabasePortOwnership {
    param($Plan, $Docker, [hashtable]$Environment)
    $occupied = @(Get-Listeners | Where-Object { $_ -in @(55432, 56379) })
    if (-not $occupied.Count) { return }
    $arguments = (Get-ComposeArguments $Plan $Docker) + @('ps', '--all', '--quiet')
    $ids = Invoke-BootstrapTool $Docker.Cli $arguments $Environment $Plan.Root 'Database ownership inspection' -Capture
    $ownedPorts = @()
    foreach ($id in @($ids.Text -split '\r?\n' | Where-Object { $_ -match '^[0-9a-f]{12,64}$' })) {
        $inspection = Invoke-BootstrapTool $Docker.Cli @('--context', $Docker.Context, 'inspect', $id) $Environment $Plan.Root 'Container ownership inspection' -Capture
        $container = @($inspection.Text | ConvertFrom-Json)[0]
        if ($container.Config.Labels.'com.docker.compose.project' -ne $Plan.Project -or -not $container.State.Running) { continue }
        foreach ($property in $container.NetworkSettings.Ports.PSObject.Properties) {
            foreach ($binding in @($property.Value)) {
                if ($binding -and $binding.HostIp -eq '127.0.0.1' -and $binding.HostPort -in @('55432', '56379')) {
                    $ownedPorts += [int]$binding.HostPort
                }
            }
        }
    }
    foreach ($port in $occupied) {
        if ($port -notin $ownedPorts) {
            throw ('Database port ' + $port + ' belongs to another setup. Close it using its own tools or use another computer. No database/process was changed.')
        }
    }
}

function Try-OpenRunningApp {
    param($Plan)
    $file = Join-Path $Plan.Directory 'running.json'
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { return $false }
    try {
        $state = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
        if ($state.ready -isnot [bool] -or $state.ready -ne $true -or $state.root -ne $Plan.Root -or
            $state.instanceId -cnotmatch '^[0-9a-f]{32}$' -or
            ($state.processId -isnot [int] -and $state.processId -isnot [long]) -or $state.processId -lt 1) { return $false }
        $process = Get-Process -Id $state.processId -ErrorAction Stop
        $expectedNode = Join-Path $Plan.Directory ('tools/node-v' + $Plan.NodeVersion + '-win-x64/node.exe')
        if ($state.nodeExecutable -ne $expectedNode -or $process.Path -ne $expectedNode) { return $false }
        $started = [DateTime]::Parse($state.processStartedAt).ToUniversalTime()
        if ([Math]::Abs(($process.StartTime.ToUniversalTime() - $started).TotalMilliseconds) -gt 2000) { return $false }
        $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3001/health' -TimeoutSec 3
        $body = $response.Content | ConvertFrom-Json
        if ($response.StatusCode -ne 200 -or $response.Headers['X-Verification-Instance'] -cne $state.instanceId -or
            $body.status -cne 'ready' -or $body.identityMode -cne 'synthetic-loopback' -or
            $body.mlsMode -cne 'mock' -or $body.deliveryMode -cne 'no-delivery') { return $false }
        $web = Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:3000' -TimeoutSec 5
        if ($web.StatusCode -ne 200) { return $false }
        Start-Process 'http://localhost:3000'
        return $true
    } catch { return $false }
}

function Initialize-BootstrapJobType {
    if (-not ('Agent8liteBootstrapJob' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public sealed class Agent8liteBootstrapJob : IDisposable {
    [StructLayout(LayoutKind.Sequential)] struct Basic {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr Minimum, Maximum;
        public uint Active;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct Counters { public ulong A,B,C,D,E,F; }
    [StructLayout(LayoutKind.Sequential)] struct Extended {
        public Basic Basic;
        public Counters IO;
        public UIntPtr ProcessMemory, JobMemory, PeakProcess, PeakJob;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool SetInformationJobObject(IntPtr job, int kind, IntPtr info, uint length);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    IntPtr handle;
    public Agent8liteBootstrapJob() {
        handle = CreateJobObject(IntPtr.Zero, null);
        if (handle == IntPtr.Zero) throw new Win32Exception();
        var value = new Extended(); value.Basic.Flags = 0x2000;
        int size = Marshal.SizeOf(value); IntPtr buffer = Marshal.AllocHGlobal(size);
        try {
            Marshal.StructureToPtr(value, buffer, false);
            if (!SetInformationJobObject(handle, 9, buffer, (uint)size)) {
                CloseHandle(handle); handle = IntPtr.Zero; throw new Win32Exception();
            }
        } finally { Marshal.FreeHGlobal(buffer); }
    }
    public void Assign(IntPtr process) {
        if (!AssignProcessToJobObject(handle, process)) throw new Win32Exception();
    }
    public void Dispose() { if(handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; } }
}
'@
    }
}

function Start-OwnedApplication {
    param($Plan, [string]$Node, [hashtable]$Environment)
    Initialize-BootstrapJobType
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $Node
    $info.Arguments = (ConvertTo-WindowsArgument (Join-Path $PSScriptRoot 'runtime.mjs')) + ' --bootstrap-handshake'
    $info.WorkingDirectory = $Plan.Root
    $info.UseShellExecute = $false
    $info.RedirectStandardInput = $true
    $info.EnvironmentVariables.Clear()
    foreach ($entry in $Environment.GetEnumerator()) { $info.EnvironmentVariables[$entry.Key] = $entry.Value }
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $info
    $job = New-Object Agent8liteBootstrapJob
    try {
        [void]$process.Start()
        $job.Assign($process.Handle)
        $process.StandardInput.WriteLine('START')
        $process.StandardInput.Close()
        $opened = $false
        do {
            if (-not $opened) { $opened = Try-OpenRunningApp $Plan }
            if ($process.WaitForExit(1000)) { break }
        } while ($true)
        if ($process.ExitCode -ne 0) { throw 'Application startup failed. Review the messages above and click again.' }
    } finally {
        # Closing this handle kills only this launch's assigned process tree, never Docker or old PIDs.
        $job.Dispose()
        $process.Dispose()
    }
}

function Invoke-WindowsBootstrap {
    $root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
    $plan = Get-BootstrapPlan $root
    if ($CheckOnly) {
        [pscustomobject]@{ root = $plan.Root; node = $plan.NodeVersion; pnpm = $plan.PnpmVersion;
            project = $plan.Project; occupiedPorts = @(Get-Listeners | Where-Object { $_ -in @(3000, 3001, 55432, 56379) });
            dockerInstalled = [bool](Find-DockerCli); actionsPerformed = @() } | ConvertTo-Json
        return
    }
    if ($env:OS -ne 'Windows_NT' -or
        ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64' -and $env:PROCESSOR_ARCHITEW6432 -ne 'AMD64')) {
        throw 'This launcher supports 64-bit Intel/AMD Windows. Use the manual runbook on other systems.'
    }
    foreach ($directory in @($plan.Root, (Join-Path $plan.Root 'apps/web'))) {
        $privateFiles = @(Get-ChildItem -LiteralPath $directory -Filter '.env*' -File -Force |
            Where-Object Name -NE '.env.example')
        if ($privateFiles.Count) { throw 'Private .env files are present. Use a clean source package without secret environment files.' }
    }
    [void][IO.Directory]::CreateDirectory($plan.Directory)
    $lock = $null
    try { $lock = [IO.File]::Open((Join-Path $plan.Directory 'setup.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
    catch [IO.IOException] {
        if (-not (Try-OpenRunningApp $plan)) { Write-Host 'Agent8lite setup is already running in another window. Complete that window first.' }
        return
    }
    try {
        Write-Host 'Agent8lite local setup - fictional data and no-delivery providers'
        Write-Host 'Keep this window open while using the app. Setup resumes when clicked again.'
        Assert-AppPorts
        if (-not (Find-DockerCli) -and (@(Get-Listeners | Where-Object { $_ -in @(55432, 56379) })).Count) {
            throw 'A database port is occupied by another installation. Close it using its own tools first.'
        }
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        'registry=https://registry.npmjs.org' | Set-Content -LiteralPath (Join-Path $plan.Directory 'npmrc') -Encoding ASCII
        $environment = New-SyntheticEnvironment $plan
        Save-Phase $plan 'portable-tools'
        $node = Ensure-Node $plan $environment
        $environment = New-SyntheticEnvironment $plan ([IO.Path]::GetDirectoryName($node))
        $environment['AGENT8LITE_BOOTSTRAP_NODE'] = $node
        $pnpm = Ensure-Pnpm $plan $node $environment
        $docker = Ensure-Docker $plan $environment
        Assert-AppPorts
        Assert-DatabasePortOwnership $plan $docker $environment
        Write-Host '[4/6] Installing/verifying project dependencies...'
        Save-Phase $plan 'dependencies'
        [void](Invoke-BootstrapTool $node @($pnpm, 'install', '--frozen-lockfile',
            '--store-dir', (Join-Path $plan.Directory 'pnpm-store')) $environment $plan.Root 'Project dependency installation')
        Write-Host '[5/6] Starting this folder''s database and initializing sample data...'
        Save-Phase $plan 'database'
        $arguments = (Get-ComposeArguments $plan $docker) + @('up', '-d', '--wait', '--wait-timeout', '180')
        [void](Invoke-BootstrapTool $docker.Cli $arguments $environment $plan.Root 'Local database startup' -TimeoutSeconds 600)
        $redis = (Get-ComposeArguments $plan $docker) + @('exec', '-T', 'redis', 'redis-cli', 'ping')
        $ping = Invoke-BootstrapTool $docker.Cli $redis $environment $plan.Root 'Redis readiness' -Capture
        if ($ping.Text.Trim() -ne 'PONG') { throw 'The local Redis service is not ready.' }
        [void](Invoke-BootstrapTool $node @('--import', 'tsx', 'packages/db/migrate.ts') $environment $plan.Root 'Forward migrations')
        [void](Invoke-BootstrapTool $node @('scripts/local-control-identities.mjs') $environment $plan.Root 'Synthetic identity setup')
        [void](Invoke-BootstrapTool $node @('--import', 'tsx', 'packages/db/seed.ts') $environment $plan.Root 'Fictional sample data setup')
        Write-Host '[6/6] Starting the app. The browser opens when both owned servers are ready...'
        Save-Phase $plan 'application'
        Start-OwnedApplication $plan $node $environment
        Save-Phase $plan 'stopped'
    } finally { $lock.Dispose() }
}

if (-not $LibraryOnly) {
    try { Invoke-WindowsBootstrap; exit 0 }
    catch {
        Write-Host ''
        Write-Host $_.Exception.Message -ForegroundColor Yellow
        Write-Host 'Setup kept existing data/services. See docs/runbooks/bootstrap-windows.md for recovery.'
        exit 1
    }
}
