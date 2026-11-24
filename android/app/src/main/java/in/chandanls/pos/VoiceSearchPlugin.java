package in.chandanls.pos;

import android.Manifest;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.ArrayList;

/**
 * Search by voice in the app.
 *
 * The app's WebView has no working Web Speech API, so this wraps Android's
 * own SpeechRecognizer (the phone's Google speech service). It listens inside
 * the app, with no pop-up, and works offline where the phone has the
 * English (India) speech pack. The web side is src/lib/speech/androidSpeech.ts.
 *
 * Everything is reported as one event, "voiceEvent", tagged with the number
 * of the search the page gave to start(), so the page never takes a late
 * event from a cancelled search for the current one:
 *   partial {text}    words so far
 *   level   {level}   how loud, 0 to 1
 *   result  {matches} the recogniser's guesses, best first
 *   error   {code}    as src/lib/speech/listen.ts names them
 *   end               the microphone has closed (after a result or an error)
 *
 * The microphone permission is asked for the first time it is used.
 * SpeechRecognizer must be used on the main thread.
 */
@CapacitorPlugin(
    name = "VoiceSearch",
    permissions = { @Permission(strings = { Manifest.permission.RECORD_AUDIO }, alias = "microphone") }
)
public class VoiceSearchPlugin extends Plugin {

    /** Level events are sent at most this often; Android reports far faster. */
    private static final long LEVEL_INTERVAL_MS = 80;

    private SpeechRecognizer recognizer;
    private int session;

    @PluginMethod
    public void start(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "startAfterPermission");
            return;
        }
        startNow(call);
    }

    @PermissionCallback
    private void startAfterPermission(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            call.reject("Allow the microphone for Vasavi Billing to search by voice.", "not-allowed");
            return;
        }
        startNow(call);
    }

    private void startNow(PluginCall call) {
        final int id = call.getInt("session", 0);
        final String language = call.getString("language", "en-IN");
        final int maxResults = call.getInt("maxResults", 5);
        getActivity().runOnUiThread(() -> {
            if (!SpeechRecognizer.isRecognitionAvailable(getContext())) {
                call.reject("Voice search is not available on this phone.", "unavailable");
                return;
            }
            destroy();
            session = id;
            recognizer = SpeechRecognizer.createSpeechRecognizer(getContext());
            recognizer.setRecognitionListener(new Listener(recognizer, id));

            Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            // Short queries, like a search engine's, rather than dictation.
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_WEB_SEARCH);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, language);
            intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
            intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, maxResults);
            intent.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, getContext().getPackageName());
            recognizer.startListening(intent);
            call.resolve();
        });
    }

    /** Stop listening; the result for what was said follows. */
    @PluginMethod
    public void stop(PluginCall call) {
        final int id = call.getInt("session", 0);
        getActivity().runOnUiThread(() -> {
            if (recognizer != null && session == id) recognizer.stopListening();
            call.resolve();
        });
    }

    /** Stop listening with no result. The page has already moved on, so nothing is sent. */
    @PluginMethod
    public void cancel(PluginCall call) {
        final int id = call.getInt("session", 0);
        getActivity().runOnUiThread(() -> {
            if (session == id) destroy();
            call.resolve();
        });
    }

    /** The app went to the background: never keep the microphone open behind it. */
    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        getActivity().runOnUiThread(() -> {
            if (recognizer == null) return;
            int id = session;
            destroy();
            send(id, "error", "code", "failed");
            send(id, "end", null, null);
        });
    }

    @Override
    protected void handleOnDestroy() {
        destroy();
        super.handleOnDestroy();
    }

    private void destroy() {
        if (recognizer == null) return;
        try {
            recognizer.cancel();
            recognizer.destroy();
        } catch (RuntimeException ignored) {
            // Already gone.
        }
        recognizer = null;
    }

    private void send(int id, String type, String key, Object value) {
        JSObject event = new JSObject();
        event.put("session", id);
        event.put("type", type);
        if (key != null) event.put(key, value);
        notifyListeners("voiceEvent", event);
    }

    private static String errorCode(int error) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            if (error == SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED || error == SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE) {
                return "unavailable";
            }
            if (error == SpeechRecognizer.ERROR_SERVER_DISCONNECTED) return "network";
        }
        switch (error) {
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS:
                return "not-allowed";
            case SpeechRecognizer.ERROR_NO_MATCH:
            case SpeechRecognizer.ERROR_SPEECH_TIMEOUT:
                return "no-speech";
            case SpeechRecognizer.ERROR_NETWORK:
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT:
            case SpeechRecognizer.ERROR_SERVER:
                return "network";
            case SpeechRecognizer.ERROR_AUDIO:
                return "no-microphone";
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY:
                return "busy";
            default:
                return "failed";
        }
    }

    /** One search's listener. Events from a recogniser that has since been replaced are dropped. */
    private class Listener implements RecognitionListener {
        private final SpeechRecognizer owner;
        private final int id;
        private long lastLevelAt;

        Listener(SpeechRecognizer owner, int id) {
            this.owner = owner;
            this.id = id;
        }

        private boolean current() {
            return recognizer == owner;
        }

        private void finish() {
            destroy();
            send(id, "end", null, null);
        }

        @Override
        public void onPartialResults(Bundle partial) {
            if (!current()) return;
            ArrayList<String> words = partial.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
            if (words != null && !words.isEmpty() && words.get(0) != null && !words.get(0).trim().isEmpty()) {
                send(id, "partial", "text", words.get(0));
            }
        }

        @Override
        public void onResults(Bundle results) {
            if (!current()) return;
            ArrayList<String> words = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
            JSArray matches = new JSArray();
            if (words != null) {
                for (String word : words) {
                    if (word != null && !word.trim().isEmpty()) matches.put(word);
                }
            }
            send(id, "result", "matches", matches);
            finish();
        }

        @Override
        public void onError(int error) {
            if (!current()) return;
            send(id, "error", "code", errorCode(error));
            finish();
        }

        @Override
        public void onRmsChanged(float rmsdB) {
            if (!current()) return;
            long now = SystemClock.elapsedRealtime();
            if (now - lastLevelAt < LEVEL_INTERVAL_MS) return;
            lastLevelAt = now;
            // Roughly -2 dB in silence to 10 dB for a raised voice.
            double level = Math.max(0, Math.min(1, (rmsdB + 2) / 12.0));
            send(id, "level", "level", level);
        }

        @Override public void onReadyForSpeech(Bundle params) { }
        @Override public void onBeginningOfSpeech() { }
        @Override public void onBufferReceived(byte[] buffer) { }
        @Override public void onEndOfSpeech() { }
        @Override public void onEvent(int eventType, Bundle params) { }
    }
}
