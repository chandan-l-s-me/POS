@echo off
rem Update Vyapara Billing. Asks for administrator permission once.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\update.ps1" %*
