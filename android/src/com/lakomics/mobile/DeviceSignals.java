package com.lakomics.mobile;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Build;

/**
 * Connectivity and power changes while an activity is resumed (PERF-ALL-001 §8).
 *
 * The Library pass, the status long-poll and the WebView warm-ups used to discover a
 * reconnect or a plugged-in charger on their next timer. This reports both as they happen:
 *
 * - network: the default network appeared or went away (`online`), and whether a validated
 *   network that was not the last one seen validated appeared (`restored`: a reconnect or a
 *   switch). "Validated default network" is what counts, so a Tailscale VPN on top of Wi-Fi
 *   is online like the Wi-Fi itself;
 * - power: charger connected/disconnected or battery okay/low.
 *
 * Registered in `onResume` and unregistered in `onPause`, so nothing listens in the
 * background. `ACCESS_NETWORK_STATE` is a normal install-time permission.
 */
final class DeviceSignals {
    interface Listener {
        /** `initial` is the state read at registration, not a change the page must hear about. */
        void network(boolean online, boolean restored, boolean initial);
        void power();
    }

    /** The owner; its application context is resolved at registration (an activity field is built before attach). */
    private final Context owner;
    private final Listener listener;
    private Context context;
    private ConnectivityManager.NetworkCallback callback;
    private BroadcastReceiver receiver;
    /** The current default network and the last one announced as validated; guarded by this. */
    private Network current, validated;

    DeviceSignals(Context context, Listener listener) {
        this.owner = context;
        this.listener = listener;
    }

    synchronized void register() {
        if (callback != null || receiver != null) return;
        context = owner.getApplicationContext();
        ConnectivityManager connectivity = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
        if (connectivity != null) {
            Network active = connectivity.getActiveNetwork();
            current = active;
            validated = active != null && isValidated(connectivity.getNetworkCapabilities(active)) ? active : null;
            listener.network(active != null, false, true);
            callback = new ConnectivityManager.NetworkCallback() {
                @Override public void onAvailable(Network network) { available(network, null); }
                @Override public void onCapabilitiesChanged(Network network, NetworkCapabilities capabilities) { available(network, capabilities); }
                @Override public void onLost(Network network) { lost(network); }
            };
            try { connectivity.registerDefaultNetworkCallback(callback); }
            catch (RuntimeException refused) { callback = null; /* Timers still cover it. */ }
        }
        IntentFilter filter = new IntentFilter();
        filter.addAction(Intent.ACTION_POWER_CONNECTED);
        filter.addAction(Intent.ACTION_POWER_DISCONNECTED);
        filter.addAction(Intent.ACTION_BATTERY_OKAY);
        filter.addAction(Intent.ACTION_BATTERY_LOW);
        receiver = new BroadcastReceiver() {
            @Override public void onReceive(Context c, Intent intent) { listener.power(); }
        };
        // System broadcasts reach a non-exported receiver; nothing else may send to it.
        if (Build.VERSION.SDK_INT >= 33) context.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED);
        else context.registerReceiver(receiver, filter);
    }

    synchronized void unregister() {
        if (context == null) return;
        if (callback != null) {
            ConnectivityManager connectivity = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
            try { if (connectivity != null) connectivity.unregisterNetworkCallback(callback); } catch (RuntimeException ignored) { }
            callback = null;
        }
        if (receiver != null) {
            try { context.unregisterReceiver(receiver); } catch (RuntimeException ignored) { }
            receiver = null;
        }
    }

    private static boolean isValidated(NetworkCapabilities capabilities) {
        return capabilities != null && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);
    }

    private void available(Network network, NetworkCapabilities capabilities) {
        boolean wasOffline, restored;
        synchronized (this) {
            if (callback == null) return;
            wasOffline = current == null;
            current = network;
            restored = isValidated(capabilities) && !network.equals(validated);
            if (restored) validated = network;
        }
        if (wasOffline || restored) listener.network(true, restored, false);
    }

    private void lost(Network network) {
        synchronized (this) {
            // A late loss of the previous default after a switch is not "offline".
            if (callback == null || !network.equals(current)) return;
            current = null;
            validated = null;
        }
        listener.network(false, false, false);
    }
}
