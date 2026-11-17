package com.shivam.staff;

import android.app.job.JobParameters;
import android.app.job.JobService;

/**
 * ============================================================
 * SILENT JOB SERVICE — dono silent engines ka runner (Boss 2026-11-17).
 *
 * Alarm (setAndAllowWhileIdle) -> SilentAlarmReceiver -> JobScheduler job ->
 * YE SERVICE background thread par engine chalata hai. JobService ka time
 * budget (10 min) BroadcastReceiver ke 10s limit se bada hai — REST writes
 * + single fix comfortably fit. NO notification, NO foreground service.
 *
 * Job IDs (extras-free — ID hi kind hai):
 *   4401 = worker silent check (WorkerSilentEngine)
 *   4402 = sales silent tower ping (SalesSilentEngine)
 * ============================================================
 */
public class SilentJobService extends JobService {

    private static final java.util.concurrent.ExecutorService EXEC =
            java.util.concurrent.Executors.newSingleThreadExecutor();

    @Override
    public boolean onStartJob(JobParameters params) {
        final int jobId = params.getJobId();
        final JobParameters p = params;
        EXEC.execute(() -> {
            try {
                if (jobId == 4401) {
                    WorkerSilentEngine.run(SilentJobService.this);
                } else if (jobId == 4402) {
                    SalesSilentEngine.run(SilentJobService.this);
                }
            } catch (Exception ignore) {
                // engine kabhi crash nahi hoga — par jobFinished phir bhi zaroori
            } finally {
                try {
                    jobFinished(p, false);
                } catch (Exception ignore) {
                }
            }
        });
        return true; // kaam background me chal raha hai — jobFinished baad me
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        // system ne rok diya (rare) — dobara run nahi karte, next alarm sambhalega
        return false;
    }
}
