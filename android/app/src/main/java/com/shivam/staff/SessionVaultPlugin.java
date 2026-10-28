package com.shivam.staff;

import android.content.Context;
import android.content.SharedPreferences;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * SESSION VAULT (never-logout, Boss rule: "ek baar login -> kabhi logout nahi").
 *
 * WebView ka localStorage/IndexedDB OEM storage-cleaners, WebView provider
 * updates aur low-storage eviction se WIPE ho sakta hai — us case me Firebase
 * session + cached profile + stored credentials TINO gayab ho jate hain aur
 * login screen aa jati hai (Boss device par yehi ho raha tha).
 *
 * SharedPreferences app-data ke shared_prefs/ folder me rehte hain — WebView
 * storage se BILKUL ALAG jagah. Yahan sirf "Clear Data" ya uninstall inhe
 * mita sakta hai. Isliye session credentials + profile ka native backup
 * yahan save hota hai; boot par WebView storage khali mile to isi se restore.
 */
@CapacitorPlugin(name = "SessionVault")
public class SessionVaultPlugin extends Plugin {

    private static final String PREFS_FILE = "shivam_session_vault";

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS_FILE, Context.MODE_PRIVATE);
    }

    @PluginMethod
    public void set(PluginCall call) {
        String key = call.getString("key");
        String value = call.getString("value");
        if (key == null || key.isEmpty()) {
            call.reject("missing key");
            return;
        }
        try {
            SharedPreferences.Editor e = prefs().edit();
            if (value == null) {
                e.remove(key);
            } else {
                e.putString(key, value);
            }
            e.apply();
            call.resolve();
        } catch (Exception ex) {
            call.reject("vault set failed: " + ex.getMessage());
        }
    }

    @PluginMethod
    public void get(PluginCall call) {
        String key = call.getString("key");
        if (key == null || key.isEmpty()) {
            call.reject("missing key");
            return;
        }
        try {
            JSObject ret = new JSObject();
            String v = prefs().getString(key, null);
            if (v != null) {
                ret.put("value", v);
            }
            call.resolve(ret);
        } catch (Exception ex) {
            call.reject("vault get failed: " + ex.getMessage());
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String key = call.getString("key");
        if (key == null || key.isEmpty()) {
            call.reject("missing key");
            return;
        }
        try {
            prefs().edit().remove(key).apply();
            call.resolve();
        } catch (Exception ex) {
            call.reject("vault remove failed: " + ex.getMessage());
        }
    }
}
