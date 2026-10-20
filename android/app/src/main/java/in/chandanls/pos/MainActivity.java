package in.chandanls.pos;

import android.os.Bundle;
import android.view.WindowManager;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    // Asks Quick Bill to close its top step (src/lib/backButton.ts). Any answer
    // but true, as from the Cloudflare sign-in page or a page still loading,
    // means nothing is open.
    private static final String PAGE_BACK =
        "(function(){try{return window.vyaparaBack ? window.vyaparaBack() === true : false}catch(e){return false}})()";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Plugins defined in this app must be registered before the bridge starts.
        registerPlugin(BluetoothPrinterPlugin.class);
        registerPlugin(BillSharePlugin.class);
        super.onCreate(savedInstanceState);
        // A cashier billing on the shop floor should not have to keep waking the phone.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        // Back used to close the app from any step of a bill. Now it closes the
        // open sheet or number pad, one at a time; with nothing open, the app
        // goes to the background rather than closing, so a bill in progress is
        // still there when the cashier comes back to it.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                getBridge().getWebView().evaluateJavascript(PAGE_BACK, handled -> {
                    if (!"true".equals(handled)) moveTaskToBack(true);
                });
            }
        });
    }
}
