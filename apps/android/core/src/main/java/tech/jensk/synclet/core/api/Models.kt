package tech.jensk.synclet.core.api

import kotlinx.serialization.Serializable

// DTOs of Sync API v1 (docs/sync/SYNC_API.md). Unknown fields are ignored by [SyncJson].

@Serializable
data class Capabilities(
    val read: Boolean = true, val write: Boolean = false, val rename: Boolean = false,
    val move: Boolean = false, val delete: Boolean = false, val addChildren: Boolean = false,
)

@Serializable
data class PreviewInfo(
    val kind: String, val thumbnail: Boolean = false, val language: String? = null,
    val thumbnailKey: String? = null,
)

@Serializable
data class SyncItem(
    val id: String, val parentId: String? = null, val type: String, val kind: String, val name: String,
    val size: Long = 0, val mime: String? = null, val version: Long? = null, val sha256: String? = null,
    val etag: String, val contentEtag: String? = null, val createdAt: String, val modifiedAt: String,
    val documentId: String? = null, val capabilities: Capabilities = Capabilities(),
    val preview: PreviewInfo? = null, val spaceId: String? = null,
) {
    val isFolder: Boolean get() = type == "folder"
    val isSpaceRoot: Boolean get() = kind == "root"
    val space: String get() = spaceId ?: SyncSpace.PERSONAL
    val hasThumbnail: Boolean get() = preview?.thumbnail == true

    companion object { const val ROOT_ID = "root" }
}

@Serializable
data class SyncSpace(
    val id: String, val kind: String, val name: String, val rootId: String,
    val canWrite: Boolean = false, val status: String? = null,
) {
    val isMissing: Boolean get() = status == "missing"

    companion object {
        const val PERSONAL = "personal"
        fun rootIdOf(spaceId: String): String = if (spaceId == PERSONAL) SyncItem.ROOT_ID else "r_$spaceId"
    }
}

@Serializable
data class SyncAccount(
    val userId: String, val email: String? = null, val displayName: String,
    val organizationId: String, val organizationName: String = "Synclet", val slug: String,
    val canWrite: Boolean = true, val spaces: List<SyncSpace> = emptyList(), val quotaBytes: Long = 0,
    val usedBytes: Long = 0, val maxUploadBytes: Long = 0, val cursor: String = "0",
)

@Serializable
data class OfficeCapabilities(val enabled: Boolean = false, val url: String? = null)

@Serializable
data class ServerCapabilities(val versions: Boolean = false, val office: OfficeCapabilities = OfficeCapabilities())

@Serializable
data class ChildrenPage(val items: List<SyncItem>, val nextPageToken: String? = null, val cursor: String)

@Serializable
data class CursorResponse(val cursor: String)

@Serializable
data class SyncChange(val op: String, val item: SyncItem? = null, val id: String? = null) {
    val itemId: String get() = item?.id ?: id ?: error("change without id")
}

@Serializable
data class ChangesPage(val changes: List<SyncChange>, val cursor: String, val hasMore: Boolean)

@Serializable
data class DownloadToken(val url: String, val token: String, val expiresAt: String)

@Serializable
data class PreviewText(val text: String, val truncated: Boolean, val encoding: String)

@Serializable
data class SearchHit(val item: SyncItem, val path: String, val snippet: String? = null, val matched: String)

@Serializable
data class SearchResponse(val hits: List<SearchHit>, val total: Int)

@Serializable
data class TrashEntry(
    val id: String, val itemId: String, val type: String, val name: String,
    val originalPath: String, val size: Long = 0, val deletedAt: String, val expiresAt: String? = null,
    val itemCount: Int = 1, val spaceId: String? = null, val deletedBy: String? = null,
)

@Serializable
data class RestoreResult(val item: SyncItem, val restoredTo: String, val renamed: Boolean)

@Serializable
data class EmptyTrashResponse(val removed: Int)

@Serializable
data class ShareLink(
    val id: String, val itemId: String, val itemName: String, val itemType: String,
    val url: String, val hasPassword: Boolean, val expiresAt: String? = null, val allowDownload: Boolean,
    val allowUpload: Boolean, val createdAt: String, val revokedAt: String? = null, val hits: Int = 0,
    val itemTrashed: Boolean = false, val spaceId: String? = null,
)

@Serializable
data class CreateShareLink(
    val itemId: String, val password: String? = null, val expiresAt: String? = null,
    val allowDownload: Boolean = true, val allowUpload: Boolean = false,
)

@Serializable
data class SyncDevice(
    val id: String, val name: String, val platform: String, val appVersion: String,
    val createdAt: String, val lastSeenAt: String? = null, val current: Boolean? = null,
)

@Serializable
data class RegisterDeviceRequest(
    val name: String, val platform: String, val appVersion: String,
    val installationId: String? = null,
)

@Serializable
data class DeviceRegistration(val device: SyncDevice, val token: String, val account: SyncAccount)

@Serializable
data class PublicUser(
    val id: String, val username: String, val displayName: String,
    val email: String? = null, val role: String,
)

@Serializable
data class AppTokens(val accessToken: String, val refreshToken: String, val user: PublicUser)

@Serializable
data class AppTokenRequest(val code: String, val codeVerifier: String, val clientId: String, val redirectUri: String)

@Serializable
data class CreateFolderRequest(
    val parentId: String, val type: String = "folder", val name: String,
    val onConflict: String? = null,
)

@Serializable
data class ErrorBody(
    val statusCode: Int? = null, val message: String? = null, val code: String? = null,
    val item: SyncItem? = null,
)

/** `onConflict` query/body value of create and upload calls. */
enum class OnConflict(val wire: String) { FAIL("fail"), RENAME("rename") }
