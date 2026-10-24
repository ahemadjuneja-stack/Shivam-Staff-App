package com.shivam.staff;

import android.os.Bundle;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        registerPlugin(UpdaterPlugin.class);

        // Edge-to-end: content status bar + nav bar ke NEECHE tak full screen.
        // Status/nav bar transparent — app ka navy theme hi unki jagah dikhta hai.
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        WindowInsetsControllerCompat ctrl =
                WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        ctrl.setAppearanceLightStatusBars(false);   // white status bar icons (navy bg)
        ctrl.setAppearanceLightNavigationBars(false); // white nav bar icons
    }
}
