package tech.jensk.synclet.core.upload

import android.app.PendingIntent
import android.content.Context
import android.content.pm.ServiceInfo
import androidx.core.app.NotificationChannelCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.work.ForegroundInfo
import tech.jensk.synclet.core.R

/** Progress (foreground, channel `uploads`) and one-off notices (channel `upload_events`) of the upload worker. */
object UploadNotifications {
    const val CHANNEL_PROGRESS = "uploads"
    const val CHANNEL_EVENTS = "upload_events"
    const val NOTIFICATION_PROGRESS = 1001
    private const val NOTIFICATION_CONFLICT = 2001
    private const val NOTIFICATION_FAILED = 3001

    fun foregroundInfo(context: Context, entry: UploadEntry?, sent: Long): ForegroundInfo {
        createChannels(context)
        val builder = NotificationCompat.Builder(context, CHANNEL_PROGRESS)
            .setSmallIcon(R.drawable.ic_stat_upload)
            .setContentTitle(
                if (entry != null) context.getString(R.string.upload_progress_title, entry.name)
                else context.getString(R.string.upload_preparing))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
        if (entry != null && entry.size > 0) {
            builder.setProgress(100, ((sent.coerceIn(0, entry.size) * 100) / entry.size).toInt(), false)
        } else {
            builder.setProgress(0, 0, true)
        }
        launchIntent(context)?.let { builder.setContentIntent(it) }
        return ForegroundInfo(NOTIFICATION_PROGRESS, builder.build(), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    }

    /** "Saved as a conflict copy" with the copy's name. */
    fun conflict(context: Context, copyName: String) =
        notice(context, NOTIFICATION_CONFLICT + copyName.hashCode(), context.getString(R.string.upload_conflict_title), copyName)

    /** "Upload failed" with the file name. */
    fun failed(context: Context, name: String) =
        notice(context, NOTIFICATION_FAILED + name.hashCode(), context.getString(R.string.upload_failed_title), name)

    private fun notice(context: Context, id: Int, title: String, text: String) {
        createChannels(context)
        val manager = NotificationManagerCompat.from(context)
        if (!manager.areNotificationsEnabled()) return
        val builder = NotificationCompat.Builder(context, CHANNEL_EVENTS)
            .setSmallIcon(R.drawable.ic_stat_upload)
            .setContentTitle(title)
            .setContentText(text)
            .setAutoCancel(true)
        launchIntent(context)?.let { builder.setContentIntent(it) }
        try {
            manager.notify(id, builder.build())
        } catch (e: SecurityException) {
            // POST_NOTIFICATIONS not granted
        }
    }

    private fun createChannels(context: Context) {
        val manager = NotificationManagerCompat.from(context)
        manager.createNotificationChannel(
            NotificationChannelCompat.Builder(CHANNEL_PROGRESS, NotificationManagerCompat.IMPORTANCE_LOW)
                .setName(context.getString(R.string.upload_channel_progress)).build())
        manager.createNotificationChannel(
            NotificationChannelCompat.Builder(CHANNEL_EVENTS, NotificationManagerCompat.IMPORTANCE_DEFAULT)
                .setName(context.getString(R.string.upload_channel_events)).build())
    }

    private fun launchIntent(context: Context): PendingIntent? =
        context.packageManager.getLaunchIntentForPackage(context.packageName)?.let {
            PendingIntent.getActivity(context, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        }
}
