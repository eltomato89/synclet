package tech.jensk.synclet.core.upload

import android.content.Context
import android.os.SystemClock
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch

class UploadWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val accountKey = inputData.getString(KEY_ACCOUNT) ?: return Result.failure()
        val env = (applicationContext as? UploadEnvironment.Owner)?.uploadEnvironment ?: return Result.failure()
        // Cold start by WorkManager: accounts (and their sessions) may still be loading. Before the gate opens a
        // missing session means nothing; afterwards it means the account is gone.
        try {
            env.awaitReady()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            return Result.retry()
        }
        val queue = env.uploadQueue
        queue.load()
        queue.prune()                             // finished entries vanish after 24 h even without new uploads
        // Account gone: nothing to do. Its entries were removed by the sign-out itself (AppGraph.forgetAccount);
        // the worker never deletes queued uploads.
        val uploader = env.uploader(accountKey) ?: return Result.success()
        foreground(null, 0)
        while (true) {
            val entry = queue.claimNext(accountKey) ?: break
            var unexpected = false
            val outcome = try {
                transfer(queue, uploader, entry)
            } catch (e: CancellationException) {
                throw e                           // stopped: the entry stays UPLOADING and is resumed first next time
            } catch (e: Exception) {
                // Unexpected (not a SyncError): never leave the entry stuck in UPLOADING.
                unexpected = true
                UploadOutcome.Retry(e.message ?: e.javaClass.simpleName)
            }
            when (outcome) {
                is UploadOutcome.Done -> {
                    queue.markDone(entry.id, outcome.item, outcome.conflictCopyName)
                    env.onUploadFinished(entry, outcome.item)
                    outcome.conflictCopyName?.let { UploadNotifications.conflict(applicationContext, it) }
                }
                is UploadOutcome.Failed -> {
                    queue.markFailed(entry.id, outcome.failure, outcome.message)
                    UploadNotifications.failed(applicationContext, entry.name)
                    if (outcome.failure == UploadFailure.SIGNED_OUT) break   // the rest waits for the next sign-in
                }
                is UploadOutcome.Retry -> {
                    val attempts = queue.markRetry(entry.id, outcome.message)
                    if (attempts >= MAX_ATTEMPTS) {
                        queue.markFailed(entry.id, if (unexpected) UploadFailure.OTHER else UploadFailure.NETWORK, outcome.message)
                        UploadNotifications.failed(applicationContext, entry.name)
                    } else {
                        return Result.retry()
                    }
                }
                UploadOutcome.Removed -> Unit
            }
        }
        queue.prune()
        return Result.success()
    }

    /**
     * Runs one upload. Progress (throttled) goes to WorkManager, the foreground notification and the entry's `sent`,
     * so the Uploads view shows live progress for single requests too. The queue writes run in order on one
     * collector and are finished before the outcome is recorded.
     */
    private suspend fun transfer(queue: UploadQueue, uploader: Uploader, entry: UploadEntry): UploadOutcome = coroutineScope {
        val progress = Channel<Long>(Channel.CONFLATED)
        val writer = launch {
            for (sent in progress) {
                queue.update(entry.id) { if (it.status == UploadStatus.UPLOADING && sent > it.sent) it.copy(sent = sent) else it }
            }
        }
        var lastUpdate = Long.MIN_VALUE / 2
        try {
            uploader.upload(entry) { sent ->
                val t = SystemClock.elapsedRealtime()
                if (t - lastUpdate >= PROGRESS_INTERVAL_MS) {
                    lastUpdate = t
                    progress.trySend(sent)
                    setProgressAsync(workDataOf(KEY_ENTRY to entry.id, KEY_SENT to sent))
                    runCatching { setForegroundAsync(UploadNotifications.foregroundInfo(applicationContext, entry, sent)) }
                }
            }
        } finally {
            progress.close()
            writer.join()
        }
    }

    /** Foreground with progress notification (type dataSync). Not allowed when started from the background on newer Android: then it runs as normal work. */
    private suspend fun foreground(entry: UploadEntry?, sent: Long) {
        try {
            setForeground(UploadNotifications.foregroundInfo(applicationContext, entry, sent))
        } catch (e: IllegalStateException) {
            // ForegroundServiceStartNotAllowedException is an IllegalStateException
        }
    }

    companion object {
        const val KEY_ACCOUNT = "account"
        const val KEY_ENTRY = "entry"
        const val KEY_SENT = "sent"
        const val MAX_ATTEMPTS = 10
        private const val PROGRESS_INTERVAL_MS = 750L
    }
}
