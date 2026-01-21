# Ath UI (Ath Studio MVP)

This repo contains a minimal implementation of the UI + backend described in `.prompt/prompt.md`.

## Dev

Prereqs: Node.js 20+ (tested with Node 24).

```bash
npm install
npm run dev
```

- UI: http://localhost:5173
- API: http://localhost:5174

## Install Gmsh (mesh)

Windows:

```bash
npm run setup:gmsh
```

## Configuration

- `ATHUI_ATH_EXE` (optional): path to `ath.exe` (defaults to `ath-2025-06/ath.exe`).
- Output sandbox: runs in `.athui-data/projects/<id>` and sets Ath `OutputRootDir` to `<project>/outputs` at runtime.
- Mesh generation (Gmsh):
  - Set UI field `Mesh Command` to something like `C:\path\to\gmsh.exe %f -`, or set `ATHUI_MESHCMD`.
  - If left blank, the server attempts to auto-detect `gmsh.exe` on `PATH`.

## Profiles

The Studio "Profile" tab prefers Ath's native profile export (User Guide: `GridExport`, `*_profiles.csv`) over deriving a profile from the STL mesh.

- The server injects `GridExport:athui = { ExportProfiles = 1 ... }` into `project.cfg` unless your config already mentions `ExportProfiles`.
- Generated files show up under the project outputs as `*_profiles.csv` (semicolon-delimited; blank lines separate curves).
