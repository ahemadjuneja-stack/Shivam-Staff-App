package com.shivam.staff;

import android.os.Bundle;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // IMPORTANT: custom plugin ko super.onCreate() se PEHLE register karna zaroori hai.
        // Capacitor Bridge super.onCreate() me ban jata hai — uske baad register karoge to
        // plugin JS ko "not implemented" dikhta hai aur in-app update popup kabhi nahi aata.
        registerPlugin(UpdaterPlugin.class);
        // SESSION VAULT: credentials/profile ka native SharedPreferences backup
        // (WebView storage wipe par bhi session zinda rehta hai — never-logout)
        registerPlugin(SessionVaultPlugin.class);
        super.onCreate(savedInstanceState);

        // Edge-to-end: content status bar + nav bar ke NEECHE tak full screen.
        // Status/nav bar transparent — app ka navy theme hi unki jagah dikhta hai.
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        WindowInsetsControllerCompat ctrl =
                WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        ctrl.setAppearanceLightStatusBars(false);   // white status bar icons (navy bg)
        ctrl.setAppearanceLightNavigationBars(false); // white nav bar icons
    }
}
