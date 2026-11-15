@echo off
rem Update Vasavi Billing. Asks for administrator permission once.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\update.ps1" %*
