package tech.jensk.synclet.ui.sharelink

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import java.time.Instant
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import okhttp3.HttpUrl
import tech.jensk.synclet.core.api.CreateShareLink
import tech.jensk.synclet.core.api.Patch
import tech.jensk.synclet.core.api.ShareLink
import tech.jensk.synclet.core.api.ShareLinkPatch
import tech.jensk.synclet.core.api.ShareLinks
import tech.jensk.synclet.core.api.SyncApi
import tech.jensk.synclet.core.api.SyncItem
import tech.jensk.synclet.core.api.createShareLink
import tech.jensk.synclet.core.api.deleteShareLink
import tech.jensk.synclet.core.api.patchShareLink
import tech.jensk.synclet.core.api.shareLinks

class ShareLinkViewModel(
    private val api: SyncApi, private val origin: HttpUrl, val item: SyncItem, private val now: () -> Instant = Instant::now,
) : ViewModel() {
    data class Form(
        val usePassword: Boolean = false, val password: String = "", val expiresAt: Instant? = null,
        val allowDownload: Boolean = true, val allowUpload: Boolean = false,
    )

    data class State(
        val active: ShareLink? = null, val form: Form = Form(), val loading: Boolean = true, val busy: Boolean = false,
        val error: Throwable? = null, val url: String? = null, val shareEvent: Int = 0,
    )

    private val mutable = MutableStateFlow(State())
    val state: StateFlow<State> = mutable.asStateFlow()

    init { viewModelScope.launch { load() } }

    private suspend fun load() {
        try {
            adopt(ShareLinks.newestActive(api.shareLinks(item.id), now()))
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            mutable.update { it.copy(loading = false, error = e) }
        }
    }

    private fun adopt(link: ShareLink?) = mutable.update {
        it.copy(
            active = link, loading = false, busy = false, url = link?.let { l -> ShareLinks.absoluteUrl(l, origin) },
            form = if (link == null) Form() else Form(
                usePassword = link.hasPassword, expiresAt = link.expiresAt?.let(Instant::parse),
                allowDownload = link.allowDownload, allowUpload = link.allowUpload),
        )
    }

    fun edit(transform: (Form) -> Form) = mutable.update { it.copy(form = transform(it.form)) }

    /** Creates the link or saves the changes, then asks the UI to open the share sheet (shareEvent + 1). */
    fun save() = viewModelScope.launch {
        val s = mutable.value
        val f = s.form
        mutable.update { it.copy(busy = true, error = null) }
        try {
            val link = s.active?.let { active ->
                val patch = ShareLinkPatch(
                    password = when {
                        f.usePassword && f.password.isNotEmpty() -> Patch.Set(f.password)
                        !f.usePassword && active.hasPassword -> Patch.Set(null)
                        else -> Patch.Keep
                    },
                    expiresAt = if (f.expiresAt?.toString() != active.expiresAt?.let { Instant.parse(it).toString() })
                        Patch.Set(f.expiresAt?.toString()) else Patch.Keep,
                    allowDownload = f.allowDownload.takeIf { it != active.allowDownload },
                    allowUpload = (f.allowUpload && item.isFolder).takeIf { it != active.allowUpload },
                )
                if (patch.toJson().isEmpty()) active else api.patchShareLink(active.id, patch)
            } ?: api.createShareLink(CreateShareLink(
                item.id, password = f.password.takeIf { f.usePassword && it.isNotEmpty() },
                expiresAt = f.expiresAt?.toString(), allowDownload = f.allowDownload, allowUpload = f.allowUpload && item.isFolder))
            adopt(link)
            mutable.update { it.copy(shareEvent = it.shareEvent + 1) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            mutable.update { it.copy(busy = false, error = e) }
        }
    }

    fun revoke() = viewModelScope.launch {
        val active = mutable.value.active ?: return@launch
        mutable.update { it.copy(busy = true) }
        try {
            api.deleteShareLink(active.id)
            adopt(null)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            mutable.update { it.copy(busy = false, error = e) }
        }
    }
}
