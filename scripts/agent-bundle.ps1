# scripts/agent-bundle.ps1
param(
    [ValidateSet("Bundle", "Verify", "All")]
    [string]$Mode = "All",
    [string]$OutFile = ".agent-context.md"
)

$ErrorActionPreference = "Stop"

$TargetFiles = @(
    "package.json",
    "src/index.ts",
    "src/config.ts",
    "src/toolsProvider.ts",
    "lib/db.js",
    "lib/embedder.js",
    "lib/vectorIndex.js",
    "lib/retriever.js",
    "lib/parser.js"
)

if ($Mode -in @("Bundle", "All")) {
    Write-Host "[1/2] Bundling codebase snapshot to $OutFile..." -ForegroundColor Cyan
    $sb = [System.Text.StringBuilder]::new()
    [void]$sb.AppendLine("# rss-rag-cache Codebase Snapshot ($(Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))")
    [void]$sb.AppendLine()

    foreach ($relPath in $TargetFiles) {
        if (Test-Path $relPath) {
            $ext = [System.IO.Path]::GetExtension($relPath).TrimStart('.')
            $content = Get-Content -Path $relPath -Raw -Encoding UTF8
            [void]$sb.AppendLine("## File: ``$relPath``")
            [void]$sb.AppendLine("``````$ext")
            [void]$sb.AppendLine($content.TrimEnd())
            [void]$sb.AppendLine("``````")
            [void]$sb.AppendLine()
        } else {
            Write-Warning "Skipped missing file: $relPath"
        }
    }

    Set-Content -Path $OutFile -Value $sb.ToString() -Encoding UTF8
    Write-Host "Snapshot written to $OutFile ($((Get-Item $OutFile).Length / 1KB | ForEach-Object { $_.ToString('F1') }) KB)" -ForegroundColor Green
}

if ($Mode -in @("Verify", "All")) {
    Write-Host "[2/2] Running verification gates (typecheck -> unit tests -> eval harness)..." -ForegroundColor Cyan
    npm run typecheck
    if ($LASTEXITCODE -ne 0) { throw "Typecheck failed." }

    npm test
    if ($LASTEXITCODE -ne 0) { throw "Unit tests failed." }

    npm run eval
    if ($LASTEXITCODE -ne 0) { throw "Evaluation harness failed or regressed." }

    Write-Host "All verification gates passed." -ForegroundColor Green
}