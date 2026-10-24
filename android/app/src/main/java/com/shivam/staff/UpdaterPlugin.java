package com.shivam.staff;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * In-app updater: downloads the release APK inside the app (no browser)
 * and hands it to the Android package installer.
 */
@CapacitorPlugin(name = "Updater")
public class UpdaterPlugin extends Plugin {

    private File updatesDir() {
        File d = new File(getContext().getFilesDir(), "updates");
        if (!d.exists()) {
            d.mkdirs();
        }
        return d;
    }

    private File apkFile(int versionCode) {
        return new File(updatesDir(), "update-" + versionCode + ".apk");
    }

    @PluginMethod
    public void getReadyApk(PluginCall call) {
        Integer vc = call.getInt("versionCode");
        if (vc == null) {
            call.reject("versionCode required");
            return;
        }
        File f = apkFile(vc);
        JSObject ret = new JSObject();
        boolean ready = f.exists() && f.length() > 0;
        ret.put("exists", ready);
        if (ready) {
            ret.put("path", f.getAbsolutePath());
            ret.put("size", f.length());
        }
        call.resolve(ret);
    }

    @PluginMethod
    public void downloadApk(PluginCall call) {
        final String url = call.getString("url");
        final Integer vc = call.getInt("versionCode");
        if (url == null || vc == null) {
            call.reject("url and versionCode required");
            return;
        }
        final Context ctx = getContext();
        final File out = apkFile(vc);

        // Already downloaded? Resolve immediately (no re-download).
        if (out.exists() && out.length() > 0) {
            JSObject ret = new JSObject();
            ret.put("path", out.getAbsolutePath());
            ret.put("size", out.length());
            ret.put("cached", true);
            call.resolve(ret);
            return;
        }

        new Thread(new Runnable() {
            @Override
            public void run() {
                File tmp = new File(updatesDir(), "update-" + vc + ".tmp");
                HttpURLConnection conn = null;
                try {
                    URL u = new URL(url);
                    conn = (HttpURLConnection) u.openConnection();
                    conn.setConnectTimeout(15000);
                    conn.setReadTimeout(60000);
                    conn.setInstanceFollowRedirects(true);
                    conn.connect();
                    int code = conn.getResponseCode();
                    if (code < 200 || code >= 300) {
                        call.reject("HTTP " + code);
                        return;
                    }
                    long total = conn.getContentLength();
                    InputStream in = conn.getInputStream();
                    FileOutputStream fos = new FileOutputStream(tmp);
                    byte[] buf = new byte[16384];
                    long done = 0;
                    int lastPct = 0;
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        fos.write(buf, 0, n);
                        done += n;
                        if (total > 0) {
                            int pct = (int) (done * 100 / total);
                            if (pct >= lastPct + 10) {
                                lastPct = pct;
                                JSObject p = new JSObject();
                                p.put("progress", pct);
                                notifyListeners("progress", p);
                            }
                        }
                    }
                    fos.flush();
                    fos.close();
                    in.close();
                    if (out.exists()) {
                        out.delete();
                    }
                    if (!tmp.renameTo(out)) {
                        call.reject("finalize failed");
                        return;
                    }
                    JSObject ret = new JSObject();
                    ret.put("path", out.getAbsolutePath());
                    ret.put("size", out.length());
                    ret.put("cached", false);
                    call.resolve(ret);
                } catch (Exception e) {
                    tmp.delete();
                    call.reject("download failed: " + e.getMessage());
                } finally {
                    if (conn != null) {
                        conn.disconnect();
                    }
                }
            }
        }).start();
    }

    @PluginMethod
    public void installApk(PluginCall call) {
        String path = call.getString("path");
        if (path == null) {
            call.reject("path required");
            return;
        }
        try {
            File apk = new File(path);
            if (!apk.exists() || apk.length() == 0) {
                call.reject("apk file missing");
                return;
            }
            Uri uri = FileProvider.getUriForFile(
                    getContext(),
                    getContext().getPackageName() + ".fileprovider",
                    apk);
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("install failed: " + e.getMessage());
        }
    }
}
