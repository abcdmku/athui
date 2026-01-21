param(
  [string]$Version = "4.12.2",
  [string]$Dest = ".athui-data/tools/gmsh"
)

$ErrorActionPreference = "Stop"

function Ensure-Dir([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) {
    New-Item -ItemType Directory -Path $Path | Out-Null
  }
}

$zipUrl = "https://gmsh.info/bin/Windows/gmsh-$Version-Windows64.zip"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$destPath = (Resolve-Path (Join-Path $repoRoot $Dest) -ErrorAction SilentlyContinue)
if ($null -eq $destPath) { $destPath = Join-Path $repoRoot $Dest } else { $destPath = $destPath.Path }

$tmpRoot = Join-Path $env:TEMP ("athui-gmsh-" + [Guid]::NewGuid().ToString("n"))
$zipPath = Join-Path $tmpRoot "gmsh.zip"

try {
  Ensure-Dir $tmpRoot

  Write-Host "[gmsh] downloading $zipUrl"
  Invoke-WebRequest -Uri $zipUrl -UseBasicParsing -OutFile $zipPath

  $extractPath = Join-Path $tmpRoot "extract"
  Ensure-Dir $extractPath

  Write-Host "[gmsh] extracting"
  Expand-Archive -Path $zipPath -DestinationPath $extractPath -Force

  $extractedRoot = Get-ChildItem -LiteralPath $extractPath -Directory | Select-Object -First 1
  if ($null -eq $extractedRoot) { throw "Unexpected archive layout: no folder found." }

  $gmshExe = Join-Path $extractedRoot.FullName "gmsh.exe"
  if (-not (Test-Path -LiteralPath $gmshExe)) { throw "Unexpected archive layout: gmsh.exe not found." }

  if (Test-Path -LiteralPath $destPath) {
    Write-Host "[gmsh] removing existing $destPath"
    Remove-Item -LiteralPath $destPath -Recurse -Force
  }
  Ensure-Dir $destPath

  Write-Host "[gmsh] installing to $destPath"
  Copy-Item -Path (Join-Path $extractedRoot.FullName "*") -Destination $destPath -Recurse -Force

  $installedExe = Join-Path $destPath "gmsh.exe"
  if (-not (Test-Path -LiteralPath $installedExe)) { throw "Install failed: $installedExe missing." }

  Write-Host "[gmsh] ok: $installedExe"
  Write-Host "[gmsh] MeshCmd example:"
  Write-Host ("        `"" + $installedExe + " %f -`"")
} finally {
  if (Test-Path -LiteralPath $tmpRoot) {
    Remove-Item -LiteralPath $tmpRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
