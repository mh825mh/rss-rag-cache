Run this directly from the repo root in PowerShell. It safely extracts and creates the files, compiles TypeScript, and runs all verification gates:

```powershell
# scripts/apply-wp3.ps1
$ErrorActionPreference = "Stop"

Write-Host "=== [1/4] Backing up current src/toolsProvider.ts ===" -ForegroundColor Cyan
if (Test-Path "src/toolsProvider.ts") {
    Copy-Item "src/toolsProvider.ts" "src/toolsProvider.ts.bak" -Force
    Write-Host "Backup created: src/toolsProvider.ts.bak" -ForegroundColor Green
}

Write-Host "=== [2/4] Writing updated src/toolsProvider.ts and test ===" -ForegroundColor Cyan

$planPath = ".opencode/plan/wp3-tools.md"
if (-not (Test-Path $planPath)) {
    throw "Plan file $planPath not found! Save the task specification first."
}

$rawMd = Get-Content$planPath -Raw -Encoding UTF8

# Extract src/toolsProvider.ts block
$patternTs = '(?s)## Target File: `src/toolsProvider\.ts`\s*```typescript\r?\n(.*?)\r?\n```'
if ($rawMd -match$patternTs) {
    Set-Content -Path "src/toolsProvider.ts" -Value $matches[1] -Encoding UTF8
    Write-Host "Successfully wrote src/toolsProvider.ts" -ForegroundColor Green
} else {
    throw "Failed to extract src/toolsProvider.ts from plan."
}

# Extract test/toolsProvider.test.js block
$patternTest = '(?s)## Target File: `test/toolsProvider\.test\.js`\s*```javascript\r?\n(.*?)\r?\n```'
if ($rawMd -match $patternTest) {
    Set-Content -Path "test/toolsProvider.test.js" -Value $matches[1] -Encoding UTF8
    Write-Host "Successfully wrote test/toolsProvider.test.js" -ForegroundColor Green
} else {
    throw "Failed to extract test/toolsProvider.test.js from plan."
}

Write-Host "=== [3/4] Compiling TypeScript ===" -ForegroundColor Cyan
npx tsc
if ($LASTEXITCODE -ne 0) { throw "TypeScript build failed." }
Write-Host "TypeScript compilation clean." -ForegroundColor Green

Write-Host "=== [4/4] Executing Verification Gates ===" -ForegroundColor Cyan
npm test
if ($LASTEXITCODE -ne 0) { throw "npm test failed." }

npm run eval
if ($LASTEXITCODE -ne 0) { throw "npm run eval failed." }

Write-Host "===========================================================" -ForegroundColor Green
Write-Host " WP-3 APPLIED & VERIFIED SUCCESSFULLY: ALL GATES PASSING  " -ForegroundColor Green
Write-Host "===========================================================" -ForegroundColor Green