package in.chandanls.pos;

import android.Manifest;
import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothSocket;
import android.content.Context;
import android.os.Build;
import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.IOException;
import java.io.OutputStream;
import java.util.Set;
import java.util.UUID;

/**
 * Prints to a Bluetooth thermal receipt printer.
 *
 * Almost every pocket thermal printer speaks ESC/POS over classic Bluetooth's
 * serial port profile (SPP), which a web page cannot reach. The web side
 * (src/lib/nativePrinter.ts) builds the receipt bytes; this only lists the
 * printers paired in Android's Bluetooth settings and writes bytes to one.
 *
 * Android 12+ needs the "Nearby devices" (BLUETOOTH_CONNECT) permission,
 * which is asked for the first time it is used.
 */
@CapacitorPlugin(
    name = "BluetoothPrinter",
    permissions = { @Permission(strings = { Manifest.permission.BLUETOOTH_CONNECT }, alias = "bluetooth") }
)
public class BluetoothPrinterPlugin extends Plugin {

    /** The standard serial port profile, which ESC/POS printers listen on. */
    private static final UUID SPP = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");

    private boolean needsPermission() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && getPermissionState("bluetooth") != PermissionState.GRANTED;
    }

    private BluetoothAdapter adapter() {
        BluetoothManager manager = (BluetoothManager) getContext().getSystemService(Context.BLUETOOTH_SERVICE);
        return manager == null ? null : manager.getAdapter();
    }

    @PluginMethod
    public void listPaired(PluginCall call) {
        if (needsPermission()) {
            requestPermissionForAlias("bluetooth", call, "listAfterPermission");
            return;
        }
        listNow(call);
    }

    @PermissionCallback
    private void listAfterPermission(PluginCall call) {
        if (needsPermission()) {
            call.reject("Allow \"Nearby devices\" for Vyapara Billing to use a Bluetooth printer.");
            return;
        }
        listNow(call);
    }

    @SuppressLint("MissingPermission")
    private void listNow(PluginCall call) {
        BluetoothAdapter adapter = adapter();
        if (adapter == null) {
            call.reject("This phone has no Bluetooth.");
            return;
        }
        if (!adapter.isEnabled()) {
            call.reject("Bluetooth is off. Turn it on and try again.");
            return;
        }
        JSArray devices = new JSArray();
        Set<BluetoothDevice> bonded = adapter.getBondedDevices();
        if (bonded != null) {
            for (BluetoothDevice device : bonded) {
                JSObject entry = new JSObject();
                entry.put("name", device.getName() == null ? "" : device.getName());
                entry.put("address", device.getAddress());
                devices.put(entry);
            }
        }
        JSObject result = new JSObject();
        result.put("devices", devices);
        call.resolve(result);
    }

    @PluginMethod
    public void print(PluginCall call) {
        if (needsPermission()) {
            requestPermissionForAlias("bluetooth", call, "printAfterPermission");
            return;
        }
        printNow(call);
    }

    @PermissionCallback
    private void printAfterPermission(PluginCall call) {
        if (needsPermission()) {
            call.reject("Allow \"Nearby devices\" for Vyapara Billing to use a Bluetooth printer.");
            return;
        }
        printNow(call);
    }

    private void printNow(PluginCall call) {
        final String address = call.getString("address");
        final String data = call.getString("data");
        if (address == null || data == null) {
            call.reject("Printer address and receipt are required.");
            return;
        }
        final byte[] bytes;
        try {
            bytes = Base64.decode(data, Base64.DEFAULT);
        } catch (IllegalArgumentException e) {
            call.reject("The receipt could not be read.");
            return;
        }
        // Connecting blocks for a second or two; never on the UI thread.
        getBridge().execute(() -> write(call, address, bytes));
    }

    @SuppressLint("MissingPermission")
    private void write(PluginCall call, String address, byte[] bytes) {
        BluetoothAdapter adapter = adapter();
        if (adapter == null || !adapter.isEnabled()) {
            call.reject("Bluetooth is off. Turn it on and try again.");
            return;
        }
        BluetoothSocket socket = null;
        try {
            BluetoothDevice device = adapter.getRemoteDevice(address);
            adapter.cancelDiscovery(); // discovery slows a connection right down
            socket = device.createRfcommSocketToServiceRecord(SPP);
            socket.connect();
            OutputStream out = socket.getOutputStream();
            // Small chunks: cheap printers have tiny buffers and drop data sent too fast.
            for (int offset = 0; offset < bytes.length; offset += 512) {
                out.write(bytes, offset, Math.min(512, bytes.length - offset));
                out.flush();
                Thread.sleep(20);
            }
            Thread.sleep(300); // let the printer take the last bytes before the link drops
            call.resolve();
        } catch (IllegalArgumentException e) {
            call.reject("That printer address is not valid. Choose the printer again in Settings.");
        } catch (IOException e) {
            call.reject("Could not reach the printer. Is it switched on and nearby?");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            call.reject("Printing was interrupted.");
        } finally {
            if (socket != null) {
                try { socket.close(); } catch (IOException ignored) { }
            }
        }
    }
}
