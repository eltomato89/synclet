package tech.jensk.synclet.ui

object TestTags {
    const val NAV_FILES = "nav.files"; const val NAV_RECENT = "nav.recent"; const val NAV_SEARCH = "nav.search"
    const val NAV_MORE = "nav.more"; const val MORE_TRASH = "more.trash"; const val MORE_UPLOADS = "more.uploads"
    const val MORE_ACCOUNTS = "more.accounts"; const val MORE_SETTINGS = "more.settings"
    fun space(spaceId: String) = "spaces.$spaceId"
    const val ADD_MENU = "browser.add"; const val NEW_FOLDER = "browser.newFolder"
    const val UPLOAD_MEDIA = "browser.uploadMedia"; const val UPLOAD_FILES = "browser.uploadFiles"
    fun item(name: String) = "browser.item.$name"; fun itemMenu(name: String) = "browser.itemMenu.$name"
    const val RENAME = "item.rename"; const val MOVE = "item.move"; const val DELETE = "item.delete"; const val SHARE_LINK = "item.shareLink"
    const val NAME_FIELD = "dialog.name"; const val CONFIRM = "dialog.confirm"
    fun trashRestore(name: String) = "trash.restore.$name"
    const val SEARCH_FIELD = "search.field"; fun searchHit(name: String) = "search.hit.$name"
    const val SHARE_CREATE = "share.create"; const val SHARE_URL = "share.url"
    fun uploadRow(name: String) = "uploads.row.$name"
    const val LOGIN_SERVER = "login.server"; const val LOGIN_CONTINUE = "login.continue"
}
