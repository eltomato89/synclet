package tech.jensk.synclet.core.account

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStoreFile
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

enum class ViewMode { LIST, GRID }
enum class SortField { NAME, DATE, SIZE }
data class SortOrder(val field: SortField = SortField.NAME, val ascending: Boolean = true)
data class ShareTarget(val accountKey: String, val folderId: String, val folderName: String)

/** Per-device UI settings (DataStore `settings`). Create once per process. */
class AppSettings(private val store: DataStore<Preferences>) {
    private object K {
        val account = stringPreferencesKey("selectedAccount")
        val viewMode = stringPreferencesKey("viewMode")
        val sortField = stringPreferencesKey("sortField")
        val sortAscending = booleanPreferencesKey("sortAscending")
        val shareAccount = stringPreferencesKey("share.account")
        val shareFolder = stringPreferencesKey("share.folder")
        val shareFolderName = stringPreferencesKey("share.folderName")
    }

    val selectedAccount: Flow<String?> = store.data.map { it[K.account] }
    suspend fun setSelectedAccount(key: String?) { store.edit { if (key == null) it.remove(K.account) else it[K.account] = key } }

    val viewMode: Flow<ViewMode> = store.data.map { p -> p[K.viewMode]?.let { runCatching { ViewMode.valueOf(it) }.getOrNull() } ?: ViewMode.LIST }
    suspend fun setViewMode(mode: ViewMode) { store.edit { it[K.viewMode] = mode.name } }

    val sortOrder: Flow<SortOrder> = store.data.map { p ->
        SortOrder(p[K.sortField]?.let { runCatching { SortField.valueOf(it) }.getOrNull() } ?: SortField.NAME, p[K.sortAscending] ?: true)
    }
    suspend fun setSortOrder(order: SortOrder) { store.edit { it[K.sortField] = order.field.name; it[K.sortAscending] = order.ascending } }

    val lastShareTarget: Flow<ShareTarget?> = store.data.map { p ->
        val account = p[K.shareAccount]; val folder = p[K.shareFolder]
        if (account == null || folder == null) null else ShareTarget(account, folder, p[K.shareFolderName] ?: "")
    }
    suspend fun setLastShareTarget(target: ShareTarget?) {
        store.edit {
            if (target == null) { it.remove(K.shareAccount); it.remove(K.shareFolder); it.remove(K.shareFolderName) }
            else { it[K.shareAccount] = target.accountKey; it[K.shareFolder] = target.folderId; it[K.shareFolderName] = target.folderName }
        }
    }

    companion object {
        fun create(context: Context): AppSettings =
            AppSettings(PreferenceDataStoreFactory.create(produceFile = { context.preferencesDataStoreFile("settings") }))
    }
}
