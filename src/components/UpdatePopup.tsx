import React, { useEffect, useRef, useState } from 'react';
import { checkForUpdates, Updater, VersionInfo } from '../updater';
import type { PluginListenerHandle } from '@capacitor/core';

type Phase = 'idle' | 'downloading' | 'ready' | 'error';

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2500;

export default function UpdatePopup() {
  const [info, setInfo] = useState<VersionInfo | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState(0);
  const [apkPath, setApkPath] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [installErr, setInstallErr] = useState(false);
  const startedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    const downloadWithRetry = async (vi: VersionInfo): Promise<string | null> => {
      let handle: PluginListenerHandle | null = null;
      try {
        handle = await Updater.addListener('progress', (d) => {
          if (!cancelled) setProgress(d.progress);
        });
      } catch {
        // progress events optional hain
      }
      try {
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
          if (cancelled) return null;
          try {
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

    const start = async () => {
      // Purane (already-installed) version ke APK files auto-clean — mix nahi hoga
      try {
        Updater.cleanStale().catch(() => {});
      } catch {
        // plugin missing — ignore
      }

      try {
        const { updateAvailable, info: vi } = await checkForUpdates();
        if (!updateAvailable || !vi || cancelled) return;
        setInfo(vi);

        // Pehle se downloaded hai? (purane open me) — turant install popup
        try {
          const ready = await Updater.getReadyApk({ versionCode: vi.versionCode });
          if (ready.exists && ready.path) {
            if (cancelled) return;
            setApkPath(ready.path);
            setProgress(100);
            setPhase('ready');
            return;
          }
        } catch {
          // Native plugin nahi hai (web dev / bahut purana APK) — popup nahi, browser KABHI nahi
          return;
        }

        if (startedRef.current) return;
        startedRef.current = true;

        // Background download — app normally chalti rahegi, chhota pill dikhega
        if (!cancelled) setPhase('downloading');
        const path = await downloadWithRetry(vi);
        if (cancelled) return;
        if (!path) {
          setPhase('error');
          return;
        }
        setApkPath(path);
        setProgress(100);
        setDismissed(false);
        setPhase('ready');
      } catch {
        // version check hi fail hua — chup reho
      }
    };

    start();
    return () => {
      cancelled = true;
    };
  }, []);

  const retryDownload = () => {
    if (!info) return;
    startedRef.current = true;
    setInstallErr(false);
    setProgress(0);
    setPhase('downloading');
    (async () => {
      const path = await (async () => {
        let handle: PluginListenerHandle | null = null;
        try {
          handle = await Updater.addListener('progress', (d) => setProgress(d.progress));
        } catch {
          // ignore
        }
        try {
          for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            try {
              const res = await Updater.downloadApk({ url: info.apkUrl, versionCode: info.versionCode });
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
      })();
      if (!path) {
        setPhase('error');
        return;
      }
      setApkPath(path);
      setProgress(100);
      setDismissed(false);
      setPhase('ready');
    })();
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

  // Chhota non-blocking progress pill (app normal use hoti rahegi)
  if (phase === 'downloading' && !dismissed) {
    return (
      <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 animate-fadeIn">
        <div className="flex items-center gap-2 bg-[#0C1628]/95 border border-[#1D2B47] rounded-full pl-3 pr-4 py-2 shadow-xl">
          <span className="w-4 h-4 border-2 border-amber-400/30 border-t-amber-400 rounded-full animate-spin"></span>
          <span className="text-xs text-slate-300">
            Update app ke andar hi download ho raha hai{progress > 0 ? `... ${progress}%` : '...'}
          </span>
        </div>
      </div>
    );
  }

  if (phase === 'error' && info && !dismissed) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 animate-fadeIn">
        <div className="bg-[#0C1628] border border-[#1D2B47] rounded-2xl p-6 max-w-sm w-full shadow-2xl text-center space-y-4">
          <div className="w-12 h-12 bg-red-500/10 border border-red-500/30 rounded-full flex items-center justify-center mx-auto text-red-400 font-bold text-xl">
            !
          </div>
          <div>
            <h3 className="text-lg font-bold text-white uppercase tracking-wider">Download Fail</h3>
            <p className="text-sm text-slate-400 mt-1">
              Network ki wajah se update download nahi ho paya. App ke andar hi dubara koshish
              karenge — browser ki zaroorat nahi.
            </p>
          </div>
          <div className="flex gap-3 pt-2">
            <button
              onClick={() => setDismissed(true)}
              className="flex-1 py-2.5 px-4 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl font-medium text-sm transition-colors"
            >
              Baad Me
            </button>
            <button
              onClick={retryDownload}
              className="flex-1 py-2.5 px-4 bg-amber-500 hover:bg-amber-600 text-slate-950 rounded-xl font-bold text-sm transition-colors shadow-lg shadow-amber-500/20"
            >
              Phir Se Koshish Karo
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (phase !== 'ready' || !info || dismissed) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 animate-fadeIn">
      <div className="bg-[#0C1628] border border-[#1D2B47] rounded-2xl p-6 max-w-sm w-full shadow-2xl text-center space-y-4">
        <div className="w-12 h-12 bg-amber-500/10 border border-amber-500/30 rounded-full flex items-center justify-center mx-auto text-amber-400 font-bold text-xl">
          🚀
        </div>
        <div>
          <h3 className="text-lg font-bold text-white uppercase tracking-wider">Update Ready Hai!</h3>
          <p className="text-sm text-slate-400 mt-1">
            Shivam Staff ka naya version{' '}
            <span className="text-amber-400 font-semibold">({info.versionName})</span> app ke andar
            hi download ho chuka hai — bas install karna hai.
          </p>
          <p className="text-xs text-slate-500 mt-2">
            "Install Karo" dabao — Android confirm karega, Install dabate hi ho jayega. Data sab
            safe rahega, kuch uninstall ya delete karne ki zaroorat nahi. Purana file app khud
            clean kar deti hai.
          </p>
          {installErr && (
            <p className="text-xs text-amber-400 mt-2 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
              Install allow nahi hua. Phone me ise kholo: Settings &rarr; Apps &rarr; Shivam Staff
              &rarr; "Install unknown apps" &rarr; Allow karo, phir "Phir Se Install Karo" dabao.
            </p>
          )}
        </div>
        <div className="flex gap-3 pt-2">
          <button
            onClick={() => setDismissed(true)}
            className="flex-1 py-2.5 px-4 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl font-medium text-sm transition-colors"
          >
            Baad Me
          </button>
          <button
            onClick={doInstall}
            className="flex-1 py-2.5 px-4 bg-amber-500 hover:bg-amber-600 text-slate-950 rounded-xl font-bold text-sm transition-colors shadow-lg shadow-amber-500/20"
          >
            {installErr ? 'Phir Se Install Karo' : 'Install Karo'}
          </button>
        </div>
      </div>
    </div>
  );
}
