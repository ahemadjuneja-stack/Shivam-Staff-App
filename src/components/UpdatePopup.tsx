import React, { useEffect, useState } from 'react';
import { checkForUpdates, openDownloadUrl, VersionInfo } from '../updater';

const RECHECK_MS = 6 * 60 * 60 * 1000; // har 6 ghante me dobara check

export default function UpdatePopup() {
  const [updateInfo, setUpdateInfo] = useState<VersionInfo | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const run = () => {
      checkForUpdates().then(({ updateAvailable, info }) => {
        if (!cancelled && updateAvailable && info) {
          setUpdateInfo(info);
        }
      });
    };
    run();
    const id = setInterval(run, RECHECK_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (!updateInfo || dismissed) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 animate-fadeIn">
      <div className="bg-[#0C1628] border border-[#1D2B47] rounded-2xl p-6 max-w-sm w-full shadow-2xl text-center space-y-4">
        <div className="w-12 h-12 bg-amber-500/10 border border-amber-500/30 rounded-full flex items-center justify-center mx-auto text-amber-400 font-bold text-xl">
          🚀
        </div>
        <div>
          <h3 className="text-lg font-bold text-white uppercase tracking-wider">Naya Update Ready!</h3>
          <p className="text-sm text-slate-400 mt-1">
            Shivam Staff ka naya version{' '}
            <span className="text-amber-400 font-semibold">({updateInfo.versionName})</span>{' '}
            aa gaya hai.
          </p>
          <p className="text-xs text-slate-500 mt-2">
            Bas "Update Karo" dabao — app apne aap update ho jayegi. Purana data sab safe
            rahega, kuch uninstall ya delete karne ki zaroorat nahi.
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
            onClick={() => openDownloadUrl(updateInfo.apkUrl)}
            className="flex-1 py-2.5 px-4 bg-amber-500 hover:bg-amber-600 text-slate-950 rounded-xl font-bold text-sm transition-colors shadow-lg shadow-amber-500/20"
          >
            Update Karo
          </button>
        </div>
      </div>
    </div>
  );
}
