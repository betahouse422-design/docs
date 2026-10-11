@echo off
rem Doble clic para abrir el editor en Windows. Arranca un servidor local y abre el navegador.
cd /d "%~dp0.."
where node >nul 2>nul
if errorlevel 1 (
  echo Falta instalar Node.js ^(https://nodejs.org, version LTS^). Instalalo y vuelve a abrir este archivo.
  pause
  exit /b 1
)
start "" "http://localhost:8080/"
echo Editor abierto en http://localhost:8080/  -  deja esta ventana abierta mientras lo uses.
node tests\serve.mjs 8080
