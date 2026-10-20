@echo off
rem Uninstall Vyapara Billing. Asks for administrator permission once.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\uninstall.ps1" %*
