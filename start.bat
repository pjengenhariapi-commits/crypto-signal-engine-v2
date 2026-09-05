@echo off
echo ============================================
echo   Crypto Signal Engine v2.0 - Iniciando...
echo ============================================
echo.

REM Kill any process using port 3000
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3000 ^| findstr LISTENING') do (
    echo Liberando porta 3000 (PID: %%a)...
    taskkill /PID %%a /F >nul 2>&1
)

REM Stop any existing container
docker compose down >nul 2>&1

echo.
echo Iniciando o motor...
echo Acesse: http://localhost:3000
echo Senha padrao: admin123
echo.
echo Pressione Ctrl+C para parar.
echo.

docker compose up --build
