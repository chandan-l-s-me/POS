# Changes

## 1.3.0 — 24 November 2026

### Search by voice

Cashiers can say an item, customer or supplier name instead of typing it.

- **Where:** Billing (items and customer), Quick Bill on the phone, Purchases
  (items and supplier) and Items.
- **How:** tap the microphone in a search box, or press **F2** while the cursor
  is in it. Press F2 again to stop. **Ctrl+M** does the same, for keyboards
  where F2 needs the Fn key held down.
- **What happens:** the spoken words fill the search box and the list filters,
  exactly as if they had been typed. Voice never adds an item to a bill by
  itself; the cashier still picks the line.
- **Language:** English (India). Item names spoken with numbers work too, for
  example "sugar one kilo" finds "Sugar 1 kg".
- **Privacy:** the browser or phone sends the spoken words to Google's speech
  service to turn them into text. Nothing is recorded or kept by Vasavi Billing.

The first time, Chrome or the phone asks for permission to use the microphone.
Allow it once.

### New name: Vasavi Billing

The app is now called **Vasavi Billing**, previously Vyapara Billing. Updating
renames the desktop icon, the Start-menu entry and the entry in Windows
Settings → Apps. The shop's data, folders and backups stay where they were.

### Phone app 1.3 (version code 5)

Install the new phone app to use voice search on Quick Bill. It installs over
the old one; cashiers stay signed in. Phones that keep the old app still work,
but without the microphone.

### Updating a shop

1. **Counter computer:** unzip `VasaviBilling-1.3.0.zip` and double-click
   **Update Vasavi.bat**. It backs up the database first and puts the old
   version back if the new one does not start.
2. **Phones:** send the new app (`app-release.apk`) over WhatsApp or USB, open
   it and choose **Update**. Allow the microphone when asked.
3. **Check:** on Billing, click in the item search, press F2 and say an item
   name.

### For developers

- `npm run seed:test` fills an empty database with four months of realistic
  test data through the API (`scripts/seed-test-data.ts`). Never run it on a
  shop's database.
- The server's `Permissions-Policy` header now allows the microphone for the
  app's own pages (`microphone=(self)`).
- New Android plugin `VoiceSearchPlugin` (needs `RECORD_AUDIO`).
