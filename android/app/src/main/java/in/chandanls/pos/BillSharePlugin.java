package in.chandanls.pos;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.util.Base64;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;

/**
 * Sends a bill's PDF to WhatsApp.
 *
 * The web side (src/lib/billPdf.ts) makes the PDF from the printed receipt;
 * this writes it to the app's private cache and hands it to WhatsApp through
 * Android's share mechanism, with a short caption. When the customer's number
 * is known, WhatsApp opens straight in their chat ("jid"); otherwise it asks
 * for the chat. Nothing is sent until the cashier presses send.
 *
 * WhatsApp, then WhatsApp Business, then Android's share sheet if neither is
 * installed.
 */
@CapacitorPlugin(name = "BillShare")
public class BillSharePlugin extends Plugin {

    private static final String[] WHATSAPP_PACKAGES = { "com.whatsapp", "com.whatsapp.w4b" };

    @PluginMethod
    public void sharePdf(PluginCall call) {
        String data = call.getString("data");
        String fileName = call.getString("fileName", "bill.pdf");
        String phone = call.getString("phone");
        String caption = call.getString("caption", "");
        if (data == null || data.isEmpty()) {
            call.reject("The bill PDF is missing.");
            return;
        }

        File file;
        try {
            File dir = new File(getContext().getCacheDir(), "bills");
            if (!dir.exists() && !dir.mkdirs()) throw new IOException("cannot create cache folder");
            // Keep the cache small: only the latest bills.
            File[] old = dir.listFiles();
            if (old != null && old.length > 20) {
                for (File f : old) {
                    //noinspection ResultOfMethodCallIgnored
                    f.delete();
                }
            }
            file = new File(dir, fileName.replaceAll("[^A-Za-z0-9._-]", "_"));
            try (FileOutputStream out = new FileOutputStream(file)) {
                out.write(Base64.decode(data, Base64.DEFAULT));
            }
        } catch (IOException | IllegalArgumentException e) {
            call.reject("Could not save the bill PDF.");
            return;
        }

        Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", file);
        Intent intent = new Intent(Intent.ACTION_SEND);
        intent.setType("application/pdf");
        intent.putExtra(Intent.EXTRA_STREAM, uri);
        if (caption != null && !caption.isEmpty()) intent.putExtra(Intent.EXTRA_TEXT, caption);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);

        for (String pkg : WHATSAPP_PACKAGES) {
            Intent direct = new Intent(intent);
            direct.setPackage(pkg);
            if (phone != null && !phone.isEmpty()) direct.putExtra("jid", phone + "@s.whatsapp.net");
            try {
                getActivity().startActivity(direct);
                JSObject result = new JSObject();
                result.put("via", "whatsapp");
                call.resolve(result);
                return;
            } catch (ActivityNotFoundException ignored) {
                // not installed; try the next
            }
        }

        try {
            getActivity().startActivity(Intent.createChooser(intent, "Share bill"));
            JSObject result = new JSObject();
            result.put("via", "chooser");
            call.resolve(result);
        } catch (ActivityNotFoundException e) {
            call.reject("No app on this phone can share a PDF.");
        }
    }
}
