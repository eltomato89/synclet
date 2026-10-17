package tech.jensk.synclet

import android.app.Application
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import tech.jensk.synclet.core.upload.UploadEnvironment
import tech.jensk.synclet.provider.ProviderEnvironment

class SyncletApp : Application(), UploadEnvironment.Owner, ProviderEnvironment.Owner {
    val graph: AppGraph by lazy { AppGraph(this) }
    override val uploadEnvironment: UploadEnvironment get() = graph
    override val providerEnvironment: ProviderEnvironment get() = graph

    override fun onCreate() {
        super.onCreate()
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) = graph.foregroundSync.onForeground()
            override fun onStop(owner: LifecycleOwner) = graph.foregroundSync.onBackground()
        })
    }
}
