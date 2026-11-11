<#!
.SYNOPSIS
Installs the project's pinned official Python runtime and an isolated virtual environment.
.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-python.ps1
.EXAMPLE
pwsh -File scripts/setup-python.ps1 -ArchivePath C:\Downloads\python.zip -ManifestPath C:\Downloads\windows.json
#>
[CmdletBinding()]
param(
    [string] $ProjectRoot,
    [string] $ArchivePath,
    [string] $ManifestPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$version = '3.14.10'
$runtimeId = 'pythoncore-3.14-64'
$manifestUrl = 'https://www.python.org/ftp/python/3.14.10/windows-3.14.10.json'
$archiveUrl = 'https://www.python.org/ftp/python/3.14.10/python-3.14.10-amd64.zip'
$manifestHash = '47eb0a77a09048a88fae77428122c9190eff664dc14572152b249992bf9bd680'
$archiveHash = 'cc28026a650970cc1570bb127312f1f9634eb67abfe157ae6ca1acbbc627d091'
$stagingPath = $null

function Get-ProjectSha256([string] $File) {
    $stream = [IO.File]::OpenRead($File)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
    } finally { $algorithm.Dispose(); $stream.Dispose() }
}

function Assert-Hash([string] $File, [string] $Expected) {
    if (-not (Test-Path -LiteralPath $File -PathType Leaf)) {
        throw "Required file does not exist: $File"
    }
    if ((Get-ProjectSha256 $File) -ne $Expected) {
        throw "SHA256 verification failed: $File"
    }
}

function Assert-PlainDirectory([string] $Directory) {
    if (Test-Path -LiteralPath $Directory) {
        $item = Get-Item -LiteralPath $Directory -Force
        if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "Expected a normal project directory, not a file or linked directory: $Directory"
        }
    }
}

function Get-VerifiedDownload([string] $Provided, [string] $Url, [string] $Name, [string] $Hash) {
    if ($Provided) {
        $file = [IO.Path]::GetFullPath($Provided)
    } else {
        New-Item -ItemType Directory -Path $cachePath -Force | Out-Null
        $file = Join-Path $cachePath $Name
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
            $temporary = $file + '.download'
            if (Test-Path -LiteralPath $temporary) {
                throw "An unfinished download already exists. Check it before retrying: $temporary"
            }
            Invoke-WebRequest -Uri $Url -OutFile $temporary -MaximumRedirection 0 -TimeoutSec 180
            Assert-Hash $temporary $Hash
            Move-Item -LiteralPath $temporary -Destination $file
        }
    }
    Assert-Hash $file $Hash
    return $file
}

function Expand-VerifiedArchive([string] $Archive, [string] $Destination) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
    try {
        $prefix = [IO.Path]::GetFullPath($Destination).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
        foreach ($entry in $zip.Entries) {
            if ($entry.FullName.Contains(':')) { throw 'Archive contains an invalid filename.' }
            $name = $entry.FullName.Replace('/', [IO.Path]::DirectorySeparatorChar)
            $file = [IO.Path]::GetFullPath([IO.Path]::Combine($Destination, $name))
            if (-not $file.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
                throw 'Archive entry leaves the runtime directory.'
            }
            # ZIP symlinks would defeat the path check during later extraction.
            if ((($entry.ExternalAttributes -shr 16) -band 61440) -eq 40960) {
                throw 'Linked archive entries are unsupported.'
            }
            if ($entry.FullName.EndsWith('/') -or $entry.FullName.EndsWith('\')) {
                New-Item -ItemType Directory -Path $file -Force | Out-Null
            } else {
                New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($file)) -Force | Out-Null
                [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $file, $false)
            }
        }
    } finally { $zip.Dispose() }
}

function Test-Python([string] $Executable, [bool] $VirtualEnvironment) {
    if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) { throw "Python is missing: $Executable" }
    $code = "import json,struct,sys,ssl,venv,ensurepip; print(json.dumps({'version':'.'.join(map(str,sys.version_info[:3])),'bits':struct.calcsize('P')*8,'prefix':sys.prefix,'base':sys.base_prefix}))"
    $output = & $Executable -I -B -c $code
    if ($LASTEXITCODE -ne 0) { throw "Python verification failed: $Executable" }
    $info = $output | ConvertFrom-Json
    if ($info.version -ne $version -or $info.bits -ne 64) { throw 'Unexpected Python version or architecture.' }
    if ($VirtualEnvironment) {
        if ([IO.Path]::GetFullPath($info.prefix) -ne $venvPath -or [IO.Path]::GetFullPath($info.base) -ne $runtimePath) {
            throw 'The virtual environment points to a different Python installation.'
        }
    }
}

try {
    if (-not $ProjectRoot) {
        # Windows PowerShell 5 can evaluate parameter defaults before $PSScriptRoot is set.
        $ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
    }
    $project = [IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\', '/')
    if (-not (Test-Path -LiteralPath $project -PathType Container)) { throw "Project root does not exist: $project" }
    $toolsPath = Join-Path $project '.tools'
    $runtimePath = Join-Path $toolsPath ('python-' + $version)
    $venvPath = Join-Path $project '.venv'
    $cachePath = Join-Path $toolsPath 'python-downloads'
    $runtimeMarker = Join-Path $runtimePath '.guangying-python-runtime.json'
    $venvMarker = Join-Path $venvPath '.guangying-python-venv.json'
    $python = Join-Path $runtimePath 'python.exe'
    $venvPython = Join-Path $venvPath 'Scripts\python.exe'
    Assert-PlainDirectory $toolsPath
    Assert-PlainDirectory $runtimePath
    Assert-PlainDirectory $venvPath
    Assert-PlainDirectory $cachePath

    if (Test-Path -LiteralPath $runtimePath) {
        if (-not (Test-Path -LiteralPath $runtimeMarker -PathType Leaf)) {
            throw "Existing runtime has no installation record; it will not be overwritten: $runtimePath"
        }
        $record = Get-Content -LiteralPath $runtimeMarker -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($record.archiveSha256 -ne $archiveHash -or $record.version -ne $version) {
            throw 'Existing runtime does not match the pinned official package.'
        }
        Assert-Hash $python $record.executableSha256
        Test-Python $python $false
    } else {
        New-Item -ItemType Directory -Path $toolsPath -Force | Out-Null
        $verifiedManifest = Get-VerifiedDownload $ManifestPath $manifestUrl 'windows-3.14.10.json' $manifestHash
        $manifest = Get-Content -LiteralPath $verifiedManifest -Raw -Encoding UTF8 | ConvertFrom-Json
        $records = @($manifest.versions | Where-Object { $_.id -eq $runtimeId })
        if ($records.Count -ne 1 -or $records[0].url -ne $archiveUrl -or $records[0].hash.sha256 -ne $archiveHash) {
            throw 'Official manifest does not describe the pinned runtime archive.'
        }
        $verifiedArchive = Get-VerifiedDownload $ArchivePath $archiveUrl 'python-3.14.10-amd64.zip' $archiveHash
        $stagingPath = Join-Path $toolsPath ('.python-stage-' + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $stagingPath | Out-Null
        Expand-VerifiedArchive $verifiedArchive $stagingPath
        if (-not (Test-Path -LiteralPath (Join-Path $stagingPath 'python.exe') -PathType Leaf)) {
            throw 'Official runtime archive has an unexpected directory structure.'
        }
        Test-Python (Join-Path $stagingPath 'python.exe') $false
        @{
            version = $version
            archiveSha256 = $archiveHash
            manifestSha256 = $manifestHash
            executableSha256 = Get-ProjectSha256 (Join-Path $stagingPath 'python.exe')
        } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stagingPath '.guangying-python-runtime.json') -Encoding UTF8
        # The runtime is promoted before venv creation, so pyvenv.cfg records its final location.
        Move-Item -LiteralPath $stagingPath -Destination $runtimePath
        $stagingPath = $null
    }

    if (Test-Path -LiteralPath $venvPath) {
        if (-not (Test-Path -LiteralPath $venvMarker -PathType Leaf)) {
            throw "An existing virtual environment has no installation record; it will not be overwritten: $venvPath"
        }
        $record = Get-Content -LiteralPath $venvMarker -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($record.runtime -ne $runtimePath -or $record.version -ne $version) {
            throw 'Existing virtual environment belongs to another runtime.'
        }
    } else {
        New-Item -ItemType Directory -Path $venvPath | Out-Null
        @{ runtime = $runtimePath; version = $version } | ConvertTo-Json | Set-Content -LiteralPath $venvMarker -Encoding UTF8
    }
    if (-not (Test-Path -LiteralPath $venvPython -PathType Leaf)) {
        & $python -I -B -m venv $venvPath
        if ($LASTEXITCODE -ne 0) { throw 'Virtual environment creation failed; the known project environment can be retried.' }
    }
    Test-Python $venvPython $true
    & $venvPython -I -B -m pip --version
    if ($LASTEXITCODE -ne 0) { throw 'The virtual environment pip check failed.' }
    [PSCustomObject]@{ Python = $venvPython; Version = $version; Project = $project; GlobalPathChanged = $false }
} catch {
    [Console]::Error.WriteLine('Python setup failed: ' + $_.Exception.Message)
    exit 1
} finally {
    if ($stagingPath -and (Test-Path -LiteralPath $stagingPath)) {
        $absoluteStage = [IO.Path]::GetFullPath($stagingPath)
        $absoluteTools = [IO.Path]::GetFullPath($toolsPath).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
        if (-not $absoluteStage.StartsWith($absoluteTools, [StringComparison]::OrdinalIgnoreCase) -or
            [IO.Path]::GetFileName($absoluteStage) -notmatch '^\.python-stage-[a-f0-9]{32}$') {
            throw 'Refusing to clean a staging directory outside the intended project tools directory.'
        }
        Remove-Item -LiteralPath $absoluteStage -Recurse -Force
    }
}
