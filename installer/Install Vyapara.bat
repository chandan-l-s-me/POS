@echo off
rem Install Vyapara Billing. Asks for administrator permission once.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install.ps1" %*
