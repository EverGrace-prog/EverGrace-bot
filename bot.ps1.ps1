param(
    [string]$action = "start"
)

# Path del progetto
$projectPath = "C:\Users\Utente\Downloads\grace-telegram-bot"

if ($action -eq "start") {
    Write-Host "🚀 Avvio del bot..."
    Set-Location $projectPath
    npm run start
}
elseif ($action -eq "stop") {
    Write-Host "🛑 Arresto del bot..."
    Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
}
else {
    Write-Host "⚠️ Uso: .\bot.ps1 start  oppure  .\bot.ps1 stop"
}
