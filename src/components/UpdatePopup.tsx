import React, { useEffect, useState } from 'react';
import { checkForUpdates, openDownloadUrl, VersionInfo } from '../updater';

export default function UpdatePopup() {
  const [updateInfo, setUpdateInfo] = useState<VersionInfo | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    checkForUpdates().then(({ updateAvailable, info }) => {
      if (updateAvailable && info) {
        setUpdateInfo(info);
      }
    });
  }, []);

  if (!updateInfo || dismissed) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 animate-fadeIn">
      <div className="bg-[#0C1628] border border-[#1D2B47] rounded-2xl p-6 max-w-sm w-full shadow-2xl text-center space-y-4">
        <div className="w-12 h-12 bg-amber-500/10 border border-amber-500/30 rounded-full flex items-center justify-center mx-auto text-amber-400 font-bold text-xl">
          🚀
        </div>
        <div>
          <h3 className="text-lg font-bold text-white uppercase tracking-wider">Update Available</h3>
          <p className="text-sm text-slate-400 mt-1">
            A new version ({updateInfo.versionName}) of Shivam Staff is ready for installation.
          </p>
        </div>
        <div className="flex gap-3 pt-2">
          <button
            onClick={() => setDismissed(true)}
            className="flex-1 py-2.5 px-4 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl font-medium text-sm transition-colors"
          >
            Later
          </button>
          <button
            onClick={() => openDownloadUrl(updateInfo.apkUrl)}
            className="flex-1 py-2.5 px-4 bg-amber-500 hover:bg-amber-600 text-slate-950 rounded-xl font-bold text-sm transition-colors shadow-lg shadow-amber-500/20"
          >
            Update Now
          </button>
        </div>
      </div>
    </div>
  );
}
