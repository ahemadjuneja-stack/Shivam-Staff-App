package com.shivam.staff;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.location.LocationManager;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * LOCATION GUARD (Boss order: "location off karne par app INSTANT band ho").
 *
 * JS-layer detection (watchPosition stall / getCurrentPosition probe) location
 * band hone par 20-60s let lagati hai — Boss ko chahiye INSTANT lock. Android
 * ka LocationManager system broadcast (PROVIDERS_CHANGED / MODE_CHANGED)
 * quick-settings se location OFF/ON hote hi MILLISECONDS me fire hota hai —
 * ye plugin wo broadcast sun kar JS ko turant bata deta hai:
 *
 *   notifyListeners("locationStateChanged", { enabled: true|false })
 *
 * Receiver runtime par register hota hai (manifest entry nahi chahiye), koi
 * naya permission nahi lagta, aur passive listener hai (koi battery cost nahi).
 * NOT_EXPORTED flag (targetSdk 34+ requirement) — system broadcast deliver
 * hote rahenge, sirf doosre apps is receiver ko target nahi kar sakte.
 */
@CapacitorPlugin(name = "LocationGuard")
public class LocationGuardPlugin extends Plugin {

    private BroadcastReceiver receiver;
    private boolean started = false;

    @PluginMethod
    public void start(PluginCall call) {
        try {
            if (started && receiver != null) {
                call.resolve();
                return;
            }
            stopInternal();
            IntentFilter filter = new IntentFilter();
            filter.addAction(LocationManager.PROVIDERS_CHANGED_ACTION);
            filter.addAction(LocationManager.MODE_CHANGED_ACTION);
            receiver = new BroadcastReceiver() {
                @Override
                public void onReceive(Context context, Intent intent) {
                    String action = intent != null ? intent.getAction() : null;
                    if (LocationManager.PROVIDERS_CHANGED_ACTION.equals(action)
                            || LocationManager.MODE_CHANGED_ACTION.equals(action)) {
                        JSObject data = new JSObject();
                        data.put("enabled", isLocationEnabled());
                        notifyListeners("locationStateChanged", data);
                    }
                }
            };
            ContextCompat.registerReceiver(
                    getContext().getApplicationContext(),
                    receiver,
                    filter,
                    ContextCompat.RECEIVER_NOT_EXPORTED);
            started = true;
            call.resolve();
        } catch (Exception e) {
            call.reject("location guard start failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        try {
            stopInternal();
            call.resolve();
        } catch (Exception e) {
            call.reject("location guard stop failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void isEnabled(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("enabled", isLocationEnabled());
        call.resolve(ret);
    }

    private void stopInternal() {
        if (receiver != null) {
            try {
                getContext().getApplicationContext().unregisterReceiver(receiver);
            } catch (Exception ignore) {
                // already unregistered
            }
            receiver = null;
        }
        started = false;
    }

    private boolean isLocationEnabled() {
        try {
            LocationManager lm = (LocationManager) getContext().getApplicationContext()
                    .getSystemService(Context.LOCATION_SERVICE);
            if (lm == null) return false;
            return lm.isProviderEnabled(LocationManager.GPS_PROVIDER)
                    || lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER);
        } catch (Exception e) {
            // unsure — true return karo, JS layers (probe/watchdog) decide karenge
            return true;
        }
    }
}
