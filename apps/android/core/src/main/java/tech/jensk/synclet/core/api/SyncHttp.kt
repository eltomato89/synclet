package tech.jensk.synclet.core.api

import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient

object SyncHttp {
    fun client(appVersion: String): OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(120, TimeUnit.SECONDS)
        .addInterceptor { chain ->
            chain.proceed(chain.request().newBuilder().header("User-Agent", "Synclet-Android/$appVersion").build())
        }
        .build()

    /** SSE: pings every 25 s; 60 s without any byte = dead connection (SYNC_API §5a). */
    fun sseClient(base: OkHttpClient): OkHttpClient = base.newBuilder()
        .readTimeout(60, TimeUnit.SECONDS)
        .callTimeout(0, TimeUnit.SECONDS)
        .retryOnConnectionFailure(false)
        .build()
}
