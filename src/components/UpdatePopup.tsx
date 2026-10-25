import React, { useEffect, useRef, useState } from 'react';
import { checkForUpdates, Updater, VersionInfo } from '../updater';
import { App as CapApp } from '@capacitor/app';
import type { PluginListenerHandle } from '@capacitor/core';

type Phase = 'idle' | 'downloading' | 'ready' | 'error' | 'checkfail';

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2500;
// Network fail par silent re-check — har 60s, max 4 (app khule rehne par bhi pakad lega)
const NET_RETRY_MAX = 4;
const NET_RETRY_DELAY_MS = 60_000;
// App wapas foreground me aane par re-check (agar 3 min se purana check ho)
const RESUME_RECHECK_MS = 3 * 60_000;

export default function UpdatePopup() {
  const [info, setInfo] = useState<VersionInfo | null>(null);
  const [localVc, setLocalVc] = useState<number | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState(0);
  const [apkPath, setApkPath] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [installErr, setInstallErr] = useState(false);
  const [checkDetail, setCheckDetail] = useState<string | null>(null);
  const [downloadErr, setDownloadErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const cancelledRef = useRef(false);
  const phaseRef = useRef<Phase>('idle');
  const downloadInFlight = useRef(false);
  const checkInFlight = useRef(false);
  const lastCheckAt = useRef(0);
  const netRetries = useRef(0);
  const noteTimer = useRef<number | null>(null);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  const showToast = (msg: string) => {
    setNote(msg);
    if (noteTimer.current) window.clearTimeout(noteTimer.current);
    noteTimer.current = window.setTimeout(() => setNote(null), 3500);
  };

  const downloadWithRetry = async (vi: VersionInfo): Promise<string | null> => {
    let handle: PluginListenerHandle | null = null;
    try {
      handle = await Updater.addListener('progress', (d) => {
        if (!cancelledRef.current) setProgress(d.progress);
      });
    } catch {
      // progress events optional hain
    }
    try {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        if (cancelledRef.current) return null;
        try {
          // Native side resume karta hai — retry par 0 se nahi, wahin se shuru hoga
          const res = await Updater.downloadApk({ url: vi.apkUrl, versionCode: vi.versionCode });
          return res.path;
        } catch (err) {
          if (attempt >= MAX_ATTEMPTS) throw err;
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
          setProgress(0);
        }
      }
      return null;
    } finally {
      if (handle) handle.remove().catch(() => {});
    }
  };

  const finishDownload = (path: string) => {
    setApkPath(path);
    setProgress(100);
    setDismissed(false);
    setPhase('ready');
  };

  const beginDownload = async (vi: VersionInfo) => {
    if (downloadInFlight.current) return;
    downloadInFlight.current = true;
    try {
      setProgress(0);
      setPhase('downloading');
      const path = await downloadWithRetry(vi);
      if (cancelledRef.current) return;
      if (!path) {
        setPhase('error');
        return;
      }
      finishDownload(path);
    } catch (e: any) {
      // 3 attempts fail — banner ATKA NAHI rahega, error card + wajah dikhegi
      if (!cancelledRef.current) {
        setDownloadErr(String(e?.message || 'download fail'));
        setPhase('error');
      }
    } finally {
      downloadInFlight.current = false;
    }
  };

  const runCheck = async (manual: boolean) => {
    if (checkInFlight.current) {
      if (manual) showToast('Update check chal raha hai...');
      return;
    }
    checkInFlight.current = true;
    try {
      const res = await checkForUpdates();
      lastCheckAt.current = Date.now();
      if (cancelledRef.current) return;

      // Diagnostics (support ke liye — koi UI nahi)
      try {
        localStorage.setItem(
          'shivam.lastCheck',
          JSON.stringify({
            t: Date.now(),
            reason: res.reason || 'none',
            remote: res.info?.versionCode ?? null,
            local: res.localVersion ?? null
          })
        );
      } catch {
        // ignore
      }

      if (res.updateAvailable && res.info) {
        netRetries.current = 0;
        setCheckDetail(null);
        setDownloadErr(null);
        setInfo(res.info);
        // Pehle se downloaded hai? (purane open me) — turant install popup
        try {
          const ready = await Updater.getReadyApk({ versionCode: res.info.versionCode });
          if (ready.exists && ready.path) {
            if (cancelledRef.current) return;
            finishDownload(ready.path);
            return;
          }
        } catch {
          // Native plugin nahi hai (web dev / bahut purana APK) — browser KABHI nahi
          return;
        }
        await beginDownload(res.info);
        return;
      }

      if (res.reason === 'network') {
        // AB CHUP NAHI — exact wajah record, retries, aur ant me card
        setCheckDetail(res.detail || 'network fail');
        if (manual) {
          showToast('Network se update check nahi ho paya — thodi der me dubara try karenge');
        }
        if (netRetries.current < NET_RETRY_MAX && phaseRef.current === 'idle') {
          netRetries.current += 1;
          window.setTimeout(() => {
            if (!cancelledRef.current) runCheck(false);
          }, NET_RETRY_DELAY_MS);
        } else if (phaseRef.current === 'idle') {
          // Retries poore — card ke saath EXACT wajah on-screen
          setPhase('checkfail');
        }
        return;
      }

      // reason 'none' — up-to-date
      setCheckDetail(null);
      if (manual) {
        showToast(localVc ? `Aap latest version pe hi ho (v${localVc})` : 'Aap latest version pe hi ho');
      }
    } catch {
      if (manual) showToast('Update check nahi ho paya — thodi der me dubara try karenge');
    } finally {
      checkInFlight.current = false;
    }
  };

  useEffect(() => {
    cancelledRef.current = false;

    // Purane (already-installed) version ke APK files auto-clean — mix nahi hoga
    try {
      Updater.cleanStale().catch(() => {});
    } catch {
      // plugin missing — ignore
    }

    // Apna version (header v-tag + toasts ke liye)
    try {
      CapApp.getInfo()
        .then((i) => {
          const n = Number((i as any).versionCode ?? (i as any).build);
          if (Number.isFinite(n) && n > 0) setLocalVc(n);
        })
        .catch(() => {});
    } catch {
      // web dev
    }

    runCheck(false);

    // Resume re-check: app background se wapas aaye aur check purana ho
    let resumeHandle: PluginListenerHandle | null = null;
    try {
      CapApp.addListener('appStateChange', (s) => {
        if (
          s.isActive &&
          phaseRef.current === 'idle' &&
          Date.now() - lastCheckAt.current > RESUME_RECHECK_MS
        ) {
          runCheck(false);
        }
      })
        .then((h) => {
          resumeHandle = h;
        })
        .catch(() => {});
    } catch {
      // web dev
    }

    // Manual check — header ke v-tag tap se (Staff ke paas hamesha ek rasta hai)
    const onManual = () => {
      if (phaseRef.current === 'downloading') {
        showToast('Update download ho raha hai...');
        return;
      }
      if (phaseRef.current === 'ready') {
        setDismissed(false);
        showToast('Update ready hai — Install Karo');
        return;
      }
      runCheck(true);
    };
    window.addEventListener('shivam:update-check', onManual);

    return () => {
      cancelledRef.current = true;
      window.removeEventListener('shivam:update-check', onManual);
      try {
        if (resumeHandle) resumeHandle.remove().catch(() => {});
      } catch {
        // ignore
      }
      if (noteTimer.current) window.clearTimeout(noteTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const retryDownload = () => {
    if (!info || downloadInFlight.current) return;
    downloadInFlight.current = true;
    setInstallErr(false);
    setProgress(0);
    setPhase('downloading');
    (async () => {
      try {
        const path = await downloadWithRetry(info);
        if (cancelledRef.current) return;
        if (!path) {
          setPhase('error');
          return;
        }
        finishDownload(path);
      } catch (e: any) {
        if (!cancelledRef.current) {
          setDownloadErr(String(e?.message || 'download fail'));
          setPhase('error');
        }
      } finally {
        downloadInFlight.current = false;
      }
    })();
  };

  const retryCheck = () => {
    netRetries.current = 0;
    setCheckDetail(null);
    setDismissed(false);
    setPhase('idle');
    runCheck(false);
  };

  // Download complete hone par dismissed reset (popup pakka dikhe)
  useEffect(() => {
    if (phase === 'ready' && apkPath) setDismissed(false);
  }, [phase, apkPath]);

  const doInstall = async () => {
    if (!apkPath) return;
    setInstallErr(false);
    try {
      await Updater.installApk({ path: apkPath });
      // Installer khul gaya — Android ab permission/install confirm karega
    } catch {
      // Browser me KABHI nahi bhejte — staff ko allow karne ka tareeqa batate hain
      setInstallErr(true);
    }
  };

  return (
    <>
      {/* Transient note (manual check / network feedback) — bottom pill */}
      {note && (
        <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 animate-fadeIn">
          <div className="rounded-full border border-slate-600/40 bg-slate-900/95 px-4 py-2 text-xs text-slate-200 shadow-xl backdrop-blur">
            {note}
          </div>
        </div>
      )}

      {/* Download banner — UPAR, header ke neeche, saaf dikhta hai (progress + version) */}
      {phase === 'downloading' && (
        <div
          className="fixed left-2 right-2 z-40 animate-fadeIn"
          style={{ top: 'calc(var(--sat) + 48px)' }}
        >
          <div className="rounded-xl border border-amber-400/25 bg-[#0C1628]/95 p-3 shadow-2xl backdrop-blur">
            <div className="flex items-center gap-2.5">
              <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-amber-400/30 border-t-amber-400"></span>
              <p className="flex-1 text-sm font-semibold text-white">
                Naya Version {info?.versionCode ?? ''} Download Ho Raha Hai
              </p>
              <span className="text-xs font-bold text-amber-400">{progress}%</span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-800">
              <div
                className="h-full rounded-full bg-amber-400 transition-all duration-300"
                style={{ width: `${progress}%` }}
              ></div>
            </div>
            <p className="mt-1.5 text-[11px] text-slate-400">
              App band mat karo — khatam hone par Install ka popup aayega
            </p>
          </div>
        </div>
      )}

      {phase === 'error' && info && !dismissed && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm animate-fadeIn">
          <div className="space-y-4 rounded-2xl border border-[#1D2B47] bg-[#0C1628] p-6 text-center shadow-2xl max-w-sm w-full">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full border border-red-500/30 bg-red-500/10 text-xl font-bold text-red-400">
              !
            </div>
            <div>
              <h3 className="text-lg font-bold uppercase tracking-wider text-white">Download Fail</h3>
              <p className="mt-1 text-sm text-slate-400">
                Network ki wajah se update download nahi ho paya. Adhoora download save rehta hai —
                dubara koshish par wahin se aage badhega. Browser ki zaroorat nahi.
              </p>
              {downloadErr && (
                <p className="mt-2 rounded-lg border border-slate-700/50 bg-slate-900/80 px-3 py-2 text-left text-[10px] break-words text-slate-500">
                  Wajah: {downloadErr}
                </p>
              )}
            </div>
            <div className="flex gap-3 pt-2">
              <button
                onClick={() => setDismissed(true)}
                className="flex-1 rounded-xl bg-slate-800 px-4 py-2.5 text-sm font-medium text-slate-300 transition-colors hover:bg-slate-700"
              >
                Baad Me
              </button>
              <button
                onClick={retryDownload}
                className="flex-1 rounded-xl bg-amber-500 px-4 py-2.5 text-sm font-bold text-slate-950 shadow-lg shadow-amber-500/20 transition-colors hover:bg-amber-600"
              >
                Phir Se Koshish Karo
              </button>
            </div>
          </div>
        </div>
      )}

      {phase === 'checkfail' && !dismissed && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm animate-fadeIn">
          <div className="space-y-4 rounded-2xl border border-[#1D2B47] bg-[#0C1628] p-6 text-center shadow-2xl max-w-sm w-full">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full border border-amber-500/30 bg-amber-500/10 text-xl font-bold text-amber-400">
              !
            </div>
            <div>
              <h3 className="text-lg font-bold uppercase tracking-wider text-white">Update Check Nahi Ho Paya</h3>
              <p className="mt-1 text-sm text-slate-400">
                App naya version check nahi kar saki — network ki dikkat lagti hai. WiFi/data check
                karke dubara koshish karo.
              </p>
              {checkDetail && (
                <p className="mt-2 rounded-lg border border-slate-700/50 bg-slate-900/80 px-3 py-2 text-left text-[10px] break-words text-slate-500">
                  {checkDetail}
                </p>
              )}
            </div>
            <div className="flex gap-3 pt-2">
              <button
                onClick={() => setDismissed(true)}
                className="flex-1 rounded-xl bg-slate-800 px-4 py-2.5 text-sm font-medium text-slate-300 transition-colors hover:bg-slate-700"
              >
                Baad Me
              </button>
              <button
                onClick={retryCheck}
                className="flex-1 rounded-xl bg-amber-500 px-4 py-2.5 text-sm font-bold text-slate-950 shadow-lg shadow-amber-500/20 transition-colors hover:bg-amber-600"
              >
                Phir Se Koshish Karo
              </button>
            </div>
          </div>
        </div>
      )}

      {phase !== 'ready' || !info || dismissed ? null : (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm animate-fadeIn">
          <div className="space-y-4 rounded-2xl border border-[#1D2B47] bg-[#0C1628] p-6 text-center shadow-2xl max-w-sm w-full">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full border border-amber-500/30 bg-amber-500/10 text-xl font-bold text-amber-400">
              🚀
            </div>
            <div>
              <h3 className="text-lg font-bold uppercase tracking-wider text-white">Update Ready Hai!</h3>
              <p className="mt-1 text-sm text-slate-400">
                Shivam Staff ka naya version{' '}
                <span className="font-semibold text-amber-400">({info.versionName})</span> app ke andar
                hi download ho chuka hai — bas install karna hai.
              </p>
              <p className="mt-2 text-xs text-slate-500">
                "Install Karo" dabao — Android confirm karega, Install dabate hi ho jayega. Data sab
                safe rahega, kuch uninstall ya delete karne ki zaroorat nahi. Purana file app khud
                clean kar deti hai.
              </p>
              {installErr && (
                <p className="mt-2 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-400">
                  Install allow nahi hua. Phone me ise kholo: Settings &rarr; Apps &rarr; Shivam Staff
                  &rarr; "Install unknown apps" &rarr; Allow karo, phir "Phir Se Install Karo" dabao.
                </p>
              )}
            </div>
            <div className="flex gap-3 pt-2">
              <button
                onClick={() => setDismissed(true)}
                className="flex-1 rounded-xl bg-slate-800 px-4 py-2.5 text-sm font-medium text-slate-300 transition-colors hover:bg-slate-700"
              >
                Baad Me
              </button>
              <button
                onClick={doInstall}
                className="flex-1 rounded-xl bg-amber-500 px-4 py-2.5 text-sm font-bold text-slate-950 shadow-lg shadow-amber-500/20 transition-colors hover:bg-amber-600"
              >
                {installErr ? 'Phir Se Install Karo' : 'Install Karo'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
