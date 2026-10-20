VYAPARA BILLING - INSTALLATION
==============================

You need: a Windows 10 or 11 computer (64-bit) and an administrator account.
Nothing else needs to be installed first.


INSTALL (once)
--------------
1. Unzip the whole folder somewhere, for example the Desktop.
2. Double-click "Install Vyapara.bat" and choose "Yes" when Windows asks
   for permission.
3. Answer the questions:
     - shop name and phone (as printed on bills)
     - an admin password (at least 10 characters, a letter and a number)
     - optionally, a USB drive or a OneDrive / Google Drive folder for a
       second copy of the daily backups
4. The app opens. Sign in as "admin" with the password you chose.
   Then fill in the address and GSTIN under Settings > Shop details, and add
   staff under Settings > Staff accounts.

After this there is nothing to start. The app runs in the background as soon
as the computer is switched on. Open it with the "Vyapara Billing" icon on the
desktop.


WHERE THINGS ARE
----------------
Program:              C:\Program Files\VyaparaBilling
Shop data & backups:  C:\VyaparaData   (only administrators can open it)
Daily backups:        C:\VyaparaData\backups  (and the second-copy folder, if set)
The app in a browser: http://127.0.0.1:3000


UPDATE (when you receive a new version)
---------------------------------------
1. Unzip the new version.
2. Double-click "Update Vyapara.bat" IN THE NEW FOLDER and choose "Yes".
The shop data is backed up first and is not changed. If the new version does
not start, the previous one is put back automatically.


UNINSTALL
---------
Settings > Apps > "Vyapara Billing" > Uninstall, or double-click
"Uninstall Vyapara.bat" in C:\Program Files\VyaparaBilling.
The shop data in C:\VyaparaData is kept. Installing again uses it.


IF SOMETHING IS WRONG
---------------------
- The icon opens a page that says it cannot connect: restart the computer.
  If it still does not open, open "Services" from the Start menu, find
  "Vyapara Billing" and click Start.
- Logs: C:\VyaparaData\logs
- Installer records: %TEMP%\VyaparaBilling-install.log (and -update, -uninstall)


KEEP THE COMPUTER AWAKE
-----------------------
The app (and the phone app, if used) only works while this computer is on.
In Control Panel > Power Options, set "When I close the lid" (plugged in) to
"Do nothing" and sleep to "Never" when plugged in.
