package tech.jensk.synclet.core.layout

import tech.jensk.synclet.core.api.SyncItem
import tech.jensk.synclet.core.api.SyncSpace

/** The client-side, read-only top level of an account: "My Files" plus team folders and external storages. */
class SpaceLayout(spaces: List<SyncSpace>) {
    val spaces: List<SyncSpace> = spaces.ifEmpty {
        listOf(SyncSpace(SyncSpace.PERSONAL, "personal", "Meine Dateien", SyncItem.ROOT_ID, canWrite = true))
    }
    fun space(id: String): SyncSpace? = spaces.firstOrNull { it.id == id }
    fun spaceForRootId(rootId: String): SyncSpace? = spaces.firstOrNull { it.rootId == rootId }
    fun isSpaceRoot(itemId: String): Boolean = spaceForRootId(itemId) != null
    fun canCreateIn(folder: SyncItem): Boolean {
        if (!folder.isFolder || !folder.capabilities.addChildren) return false
        val space = space(folder.space) ?: return folder.space == SyncSpace.PERSONAL
        return space.canWrite && !space.isMissing
    }
    /** Personal space: localised name; others: the server's name (unknown kinds like ordinary folders). */
    fun displayName(space: SyncSpace, personalName: String): String = if (space.kind == "personal") personalName else space.name
}
