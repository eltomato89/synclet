package tech.jensk.synclet.core.upload

import java.io.InputStream
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable enum class UploadKind { @SerialName("create") CREATE, @SerialName("replace") REPLACE }
@Serializable enum class UploadStatus { @SerialName("waiting") WAITING, @SerialName("uploading") UPLOADING, @SerialName("done") DONE, @SerialName("failed") FAILED }
@Serializable enum class UploadFailure {
    @SerialName("insufficient_storage") INSUFFICIENT_STORAGE, @SerialName("target_gone") TARGET_GONE,
    @SerialName("signed_out") SIGNED_OUT, @SerialName("too_large") TOO_LARGE, @SerialName("invalid_name") INVALID_NAME,
    @SerialName("read_only") READ_ONLY, @SerialName("space_unavailable") SPACE_UNAVAILABLE, @SerialName("network") NETWORK,
    @SerialName("source_missing") SOURCE_MISSING, @SerialName("other") OTHER,
}

@Serializable
data class UploadEntry(
    val id: String,
    val accountKey: String,
    val parentId: String,
    val parentName: String = "",
    val name: String,
    val size: Long,
    val kind: UploadKind = UploadKind.CREATE,
    val itemId: String? = null,          // replace: the file
    val ifMatch: String? = null,         // replace: content etag when the source was opened
    val chainAfter: String? = null,      // replace: earlier upload of the same file this one is based on
    val status: UploadStatus = UploadStatus.WAITING,
    val failure: UploadFailure? = null,  // unknown values in a newer file decode as null (coerceInputValues)
    val message: String? = null,
    val tusUrl: String? = null,
    val tusOffset: Long = 0,
    val sent: Long = 0,
    val attempts: Int = 0,
    val resultItemId: String? = null,
    val resultEtag: String? = null,
    val conflictCopyName: String? = null,
    val modifiedAt: String? = null,
    val createdAt: Long,
    val finishedAt: Long? = null,
)

fun interface UploadSource { fun open(): InputStream }
