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

    /** App ka apna (currently installed) versionCode — PackageManager se. */
    private int ownVersionCode() {
        try {
            return getContext()
                    .getPackageManager()
                    .getPackageInfo(getContext().getPackageName(), 0)
                    .versionCode;
        } catch (Exception e) {
            return 0;
        }
    }

    /**
     * Stale files clean: already-installed versions ke APK + adhoore .tmp downloads.
     * "Purana version apne aap clean ho — mix na ho" rule.
     */
    private void cleanInstalledStale(int ownVc) {
        File[] files = updatesDir().listFiles();
        if (files == null) return;
        for (File f : files) {
            String name = f.getName();
            if (name.endsWith(".tmp")) {
                // update-N.tmp — sirf NAYE (N > ownVc) version ka adhoora download
                // resume ke kaam aata hai; installed/purana version ka tmp bekaar hai
                String base = name.substring(0, name.length() - ".tmp".length());
                if (base.startsWith("update-")) {
                    try {
                        int vc = Integer.parseInt(base.substring("update-".length()));
                        if (vc <= ownVc) {
                            f.delete();
                        }
                    } catch (NumberFormatException bad) {
                        f.delete();
                    }
                } else {
                    f.delete();
                }
                continue;
            }
            if (name.startsWith("update-") && name.endsWith(".apk")) {
                String mid = name.substring("update-".length(), name.length() - ".apk".length());
                try {
                    int vc = Integer.parseInt(mid);
                    if (vc <= ownVc) {
                        f.delete(); // ye version pehle se installed hai — file bekaar
                    }
                } catch (NumberFormatException bad) {
                    f.delete(); // garbage naam
                }
            }
        }
    }

    /**
     * Strict one-file rule: sirf target version ka APK rahega — baaki sab delete.
     * Isse kabhi do alag update files ek saath nahi rehti (no mixing).
     */
    private void cleanExcept(int keepVc) {
        File[] files = updatesDir().listFiles();
        if (files == null) return;
        String keep = "update-" + keepVc + ".apk";
        String keepTmp = "update-" + keepVc + ".tmp"; // adhoora download — resume ke liye bachta hai
        for (File f : files) {
            String name = f.getName();
            if (name.equals(keep) || name.equals(keepTmp)) {
                continue;
            }
            f.delete();
        }
    }

    @PluginMethod
    public void cleanStale(PluginCall call) {
        cleanInstalledStale(ownVersionCode());
        call.resolve();
    }

    /**
     * UPDATE CHECK — NATIVE (Java HTTP). WebView/fetch/CORS ki duniya se BILKUL bahar.
     * Do independent sources, MAX versionCode jeetega (stale mirror se bachav):
     *   1. Firebase Hosting app-version.json (full info: vc + name + apkUrl)
     *   2. GitHub releases/latest ka 302 redirect — Location: .../tag/v1.0.0-30 => vc
     *      (koi API quota nahi, sirf plain HTTP redirect)
     * Dono fail ho to bhi resolve WITH errors string — app ab CHUP NAHI rahegi.
     */
    @PluginMethod
    public void checkUpdate(PluginCall call) {
        final int localVc = ownVersionCode();
        new Thread(new Runnable() {
            @Override
            public void run() {
                int bestVc = -1;
                String bestName = null;
                String bestUrl = null;
                String bestSource = null;
                StringBuilder errors = new StringBuilder();

                // SOURCE 1: Firebase Hosting version JSON
                try {
                    String body = fetchBody(
                            "https://shivam-staff-app.web.app/app-version.json?t=" + System.currentTimeMillis(),
                            10000);
                    org.json.JSONObject o = new org.json.JSONObject(body);
                    int vc = o.getInt("versionCode");
                    String name = o.optString("versionName", "1.0.0-" + vc);
                    String url = o.optString("apkUrl",
                            "https://github.com/ahemadjuneja-stack/Shivam-Staff-App/releases/latest/download/app-debug.apk");
                    if (vc > bestVc) {
                        bestVc = vc;
                        bestName = name;
                        bestUrl = url;
                        bestSource = "hosting";
                    }
                } catch (Exception e) {
                    String m = e.getMessage();
                    errors.append("hosting: ").append(m == null ? e.getClass().getSimpleName() : m).append(" | ");
                }

                // SOURCE 2: GitHub releases/latest redirect (koi API quota nahi)
                try {
                    HttpURLConnection c = (HttpURLConnection) new URL(
                            "https://github.com/ahemadjuneja-stack/Shivam-Staff-App/releases/latest").openConnection();
                    c.setConnectTimeout(10000);
                    c.setReadTimeout(10000);
                    c.setInstanceFollowRedirects(false);
                    c.setRequestProperty("Cache-Control", "no-cache");
                    int code = c.getResponseCode();
                    String loc = c.getHeaderField("Location");
                    c.disconnect();
                    if ((code == 301 || code == 302) && loc != null) {
                        String tag = loc.substring(loc.lastIndexOf('/') + 1);       // v1.0.0-30
                        String digits = tag.substring(tag.lastIndexOf('-') + 1).replaceAll("[^0-9]", "");
                        int vc = Integer.parseInt(digits);
                        if (vc > bestVc) {
                            bestVc = vc;
                            bestName = tag.startsWith("v") ? tag.substring(1) : tag; // 1.0.0-30
                            bestUrl = "https://github.com/ahemadjuneja-stack/Shivam-Staff-App/releases/latest/download/app-debug.apk";
                            bestSource = "github";
                        }
                    } else {
                        errors.append("github: HTTP ").append(code).append(" | ");
                    }
                } catch (Exception e) {
                    String m = e.getMessage();
                    errors.append("github: ").append(m == null ? e.getClass().getSimpleName() : m).append(" | ");
                }

                JSObject ret = new JSObject();
                ret.put("localVc", localVc);
                ret.put("available", bestVc > localVc);
                if (bestVc > 0) {
                    ret.put("versionCode", bestVc);
                    ret.put("versionName", bestName);
                    ret.put("apkUrl", bestUrl);
                    ret.put("source", bestSource);
                }
                if (errors.length() > 0) {
                    ret.put("errors", errors.toString());
                }
                call.resolve(ret);
            }
        }).start();
    }

    /** Chhota native GET — body string (no-cache headers ke saath, ?t= bhi lagta hai). */
    private String fetchBody(String url, int timeoutMs) throws Exception {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(timeoutMs);
            c.setReadTimeout(timeoutMs);
            c.setInstanceFollowRedirects(true);
            c.setRequestProperty("Cache-Control", "no-cache");
            c.setRequestProperty("Pragma", "no-cache");
            int code = c.getResponseCode();
            if (code < 200 || code >= 300) {
                throw new Exception("HTTP " + code);
            }
            InputStream in = c.getInputStream();
            java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) {
                bo.write(buf, 0, n);
            }
            in.close();
            return bo.toString("UTF-8");
        } finally {
            if (c != null) {
                c.disconnect();
            }
        }
    }

    @PluginMethod
    public void getReadyApk(PluginCall call) {
        Integer vc = call.getInt("versionCode");
        if (vc == null) {
            call.reject("versionCode required");
            return;
        }
        // Pehle stale/purana saaf karo, phir check — sirf pending naya APK bachta hai
        cleanInstalledStale(ownVersionCode());
        cleanExcept(vc);
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
            cleanExcept(vc); // doosri koi file nahi bachegi — sirf ye
            JSObject ret = new JSObject();
            ret.put("path", out.getAbsolutePath());
            ret.put("size", out.length());
            ret.put("cached", true);
            call.resolve(ret);
            return;
        }

        // Naya download shuru — purani saari files (doosre versions/tmp) hata do
        cleanExcept(vc);

        new Thread(new Runnable() {
            @Override
            public void run() {
                String err = downloadToFile(url, vc, out);
                if (err == null) {
                    JSObject ret = new JSObject();
                    ret.put("path", out.getAbsolutePath());
                    ret.put("size", out.length());
                    ret.put("cached", false);
                    call.resolve(ret);
                } else {
                    call.reject(err);
                }
            }
        }).start();
    }

    /**
     * Download RESUME support ke saath: adhoora .tmp pada hai to wahi se aage
     * (Range header => 206). Server Range ignore kare (200) to 0 se. Galat resume
     * point (416) ho to ek baar fresh try. Fail hone par .tmp BACHA rehta hai —
     * agla attempt ya agla app-open wahin se resume karta hai (flaky network me
     * bhi 6.7MB poora ho jata hai). Returns null on success, error string warna.
     */
    private String downloadToFile(String url, int vc, File out) {
        File tmp = new File(updatesDir(), "update-" + vc + ".tmp");
        return tryDownload(url, tmp, out, true);
    }

    private String tryDownload(String url, File tmp, File out, boolean allowFreshRetry) {
        HttpURLConnection conn = null;
        long resumeFrom = 0;
        boolean append = false;
        try {
            if (tmp.exists() && tmp.length() > 0) {
                resumeFrom = tmp.length();
                append = true;
            }
            URL u = new URL(url);
            conn = (HttpURLConnection) u.openConnection();
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(60000);
            conn.setInstanceFollowRedirects(true);
            if (resumeFrom > 0) {
                conn.setRequestProperty("Range", "bytes=" + resumeFrom + "-");
            }
            conn.connect();
            int code = conn.getResponseCode();

            if (code == 416) {
                // Resume point file size se aage — tmp corrupt/stale. Fresh start.
                if (allowFreshRetry) {
                    tmp.delete();
                    conn.disconnect();
                    return tryDownload(url, tmp, out, false);
                }
                return "HTTP 416";
            }

            if (resumeFrom > 0 && code == 200) {
                // Server ne Range ignore kiya — poora body aa raha hai, 0 se likho
                resumeFrom = 0;
                append = false;
            } else if (resumeFrom > 0 && code != 206) {
                return "HTTP " + code;
            } else if (resumeFrom == 0 && (code < 200 || code >= 300)) {
                return "HTTP " + code;
            }

            long total = conn.getContentLength();
            if (resumeFrom > 0 && code == 206 && total > 0) {
                total += resumeFrom;
            }

            InputStream in = conn.getInputStream();
            FileOutputStream fos = new FileOutputStream(tmp, append);
            byte[] buf = new byte[16384];
            long done = resumeFrom;
            int lastPct = -1;
            int n;
            while ((n = in.read(buf)) > 0) {
                fos.write(buf, 0, n);
                done += n;
                if (total > 0) {
                    int pct = (int) ((done * 100) / total);
                    if (pct > lastPct && pct <= 100) {
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
                return "finalize failed";
            }
            return null;
        } catch (Exception e) {
            // .tmp DELETE NAHI karte — resume next attempt / next app-open pe
            return "download failed: " + e.getMessage();
        } finally {
            if (conn != null) {
                conn.disconnect();
            }
        }
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
            // Android 8+: "Install unknown apps" allow na ho to seedha us app ki settings kholo
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O
                    && !getContext().getPackageManager().canRequestPackageInstalls()) {
                Intent settings = new Intent(
                        android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + getContext().getPackageName()));
                settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(settings);
                call.reject("install_permission_needed");
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
