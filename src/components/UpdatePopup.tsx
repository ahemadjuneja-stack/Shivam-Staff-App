import React, { useEffect, useRef, useState } from 'react';
import { checkForUpdates, openDownloadUrl, Updater, VersionInfo } from '../updater';
import type { PluginListenerHandle } from '@capacitor/core';

type Phase = 'idle' | 'downloading' | 'ready';

export default function UpdatePopup() {
  const [info, setInfo] = useState<VersionInfo | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState(0);
  const [apkPath, setApkPath] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const startedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    const start = async () => {
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
          // Native plugin nahi mila (web dev / purana APK) — browser fallback popup
          if (!cancelled) setPhase('ready');
          return;
        }

        if (startedRef.current) return;
        startedRef.current = true;

        // Background download — popup baad me, sirf install ke waqt
        if (!cancelled) setPhase('downloading');
        let handle: PluginListenerHandle | null = null;
        try {
          handle = await Updater.addListener('progress', (d) => {
            if (!cancelled) setProgress(d.progress);
          });
        } catch {
          // progress events optional hain
        }
        try {
          const res = await Updater.downloadApk({ url: vi.apkUrl, versionCode: vi.versionCode });
          if (cancelled) return;
          setApkPath(res.path);
          setProgress(100);
          setDismissed(false);
          setPhase('ready');
        } catch {
          // Native download fail — browser fallback popup dikha do
          if (!cancelled) setPhase('ready');
        } finally {
          if (handle) handle.remove().catch(() => {});
        }
      } catch {
        // check hi fail hua — kuch mat dikhao
      }
    };

    start();
    return () => {
      cancelled = true;
    };
  }, []);

  // Download complete hone par dismissed reset (popup pakka dikhe)
  useEffect(() => {
    if (phase === 'ready' && apkPath) setDismissed(false);
  }, [phase, apkPath]);

  const doInstall = async () => {
    if (!info || !apkPath) return;
    try {
      await Updater.installApk({ path: apkPath });
    } catch {
      // Fallback: Chrome me download (rare case)
      openDownloadUrl(info.apkUrl).catch(() => {});
    }
  };

  // Chhota non-blocking progress pill (app normal use hoti rahegi)
  if (phase === 'downloading' && !dismissed) {
    return (
      <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 animate-fadeIn">
        <div className="flex items-center gap-2 bg-[#0C1628]/95 border border-[#1D2B47] rounded-full pl-3 pr-4 py-2 shadow-xl">
          <span className="w-4 h-4 border-2 border-amber-400/30 border-t-amber-400 rounded-full animate-spin"></span>
          <span className="text-xs text-slate-300">
            Update download ho raha hai{progress > 0 ? `... ${progress}%` : '...'}
          </span>
        </div>
      </div>
    );
  }

  if (phase !== 'ready' || !info || dismissed) return null;

  const nativeReady = !!apkPath;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 animate-fadeIn">
      <div className="bg-[#0C1628] border border-[#1D2B47] rounded-2xl p-6 max-w-sm w-full shadow-2xl text-center space-y-4">
        <div className="w-12 h-12 bg-amber-500/10 border border-amber-500/30 rounded-full flex items-center justify-center mx-auto text-amber-400 font-bold text-xl">
          🚀
        </div>
        <div>
          <h3 className="text-lg font-bold text-white uppercase tracking-wider">
            {nativeReady ? 'Update Ready Hai!' : 'Naya Update Ready!'}
          </h3>
          <p className="text-sm text-slate-400 mt-1">
            Shivam Staff ka naya version{' '}
            <span className="text-amber-400 font-semibold">({info.versionName})</span>{' '}
            {nativeReady ? 'download ho chuka hai — bas install karna hai.' : 'aa gaya hai.'}
          </p>
          <p className="text-xs text-slate-500 mt-2">
            "Install Karo" dabao — Android confirm karega, Install dabate hi ho jayega. Data sab
            safe rahega, kuch uninstall ya delete karne ki zaroorat nahi.
          </p>
        </div>
        <div className="flex gap-3 pt-2">
          <button
            onClick={() => setDismissed(true)}
            className="flex-1 py-2.5 px-4 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl font-medium text-sm transition-colors"
          >
            Baad Me
          </button>
          {nativeReady ? (
            <button
              onClick={doInstall}
              className="flex-1 py-2.5 px-4 bg-amber-500 hover:bg-amber-600 text-slate-950 rounded-xl font-bold text-sm transition-colors shadow-lg shadow-amber-500/20"
            >
              Install Karo
            </button>
          ) : (
            <button
              onClick={() => openDownloadUrl(info.apkUrl)}
              className="flex-1 py-2.5 px-4 bg-amber-500 hover:bg-amber-600 text-slate-950 rounded-xl font-bold text-sm transition-colors shadow-lg shadow-amber-500/20"
            >
              Update Karo
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
