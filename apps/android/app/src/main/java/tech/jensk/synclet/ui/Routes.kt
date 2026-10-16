package tech.jensk.synclet.ui

import kotlinx.serialization.Serializable

@Serializable data object FilesRoute
@Serializable data class FolderRoute(val accountKey: String, val folderId: String, val title: String)
@Serializable data class PreviewRoute(val accountKey: String, val folderId: String?, val itemId: String)
@Serializable data class SearchRoute(val accountKey: String? = null, val folderId: String? = null, val folderName: String? = null)
@Serializable data object RecentRoute
@Serializable data object MoreRoute
@Serializable data object TrashRoute
@Serializable data object UploadsRoute
@Serializable data object AccountsRoute
@Serializable data object SettingsRoute
