package tech.jensk.synclet.core.upload

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.workDataOf
import java.util.concurrent.TimeUnit
import tech.jensk.synclet.core.api.shortKey

/** One unique work chain per account = at most one transfer per account at a time. */
object UploadScheduler {
    fun workName(accountKey: String): String = "upload-${shortKey(accountKey)}"

    /** [restart] (user pressed "Try Again"): replaces a worker that is waiting in backoff; tus resumes. */
    fun schedule(context: Context, accountKey: String, restart: Boolean = false) {
        val request = OneTimeWorkRequestBuilder<UploadWorker>()
            .setInputData(workDataOf(UploadWorker.KEY_ACCOUNT to accountKey))
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .addTag("synclet-upload")
            .build()
        val policy = if (restart) ExistingWorkPolicy.REPLACE else ExistingWorkPolicy.APPEND_OR_REPLACE
        WorkManager.getInstance(context).enqueueUniqueWork(workName(accountKey), policy, request)
    }

    fun cancel(context: Context, accountKey: String) {
        WorkManager.getInstance(context).cancelUniqueWork(workName(accountKey))
    }
}
