package in.chandanls.pos;

import android.os.Bundle;
import android.view.WindowManager;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Plugins defined in this app must be registered before the bridge starts.
        registerPlugin(BluetoothPrinterPlugin.class);
        registerPlugin(BillSharePlugin.class);
        super.onCreate(savedInstanceState);
        // A cashier billing on the shop floor should not have to keep waking the phone.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }
}
