package tech.jensk.synclet.core.account

import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import tech.jensk.synclet.core.api.SyncJson

/** `accounts.json` = `{"v":1,"accounts":[…]}`, written atomically; a broken file is moved aside. */
class AccountStore(private val file: File) {
    @Serializable private data class StoreFile(val v: Int = VERSION, val accounts: List<Account> = emptyList())

    private val mutex = Mutex()
    private var loaded = false
    private val state = MutableStateFlow<List<Account>>(emptyList())
    val accounts: StateFlow<List<Account>> = state.asStateFlow()

    suspend fun load() = mutex.withLock { ensureLoaded() }

    fun get(key: String): Account? = state.value.firstOrNull { it.key == key }

    suspend fun upsert(account: Account) = mutex.withLock {
        ensureLoaded()
        val current = state.value
        write(if (current.any { it.key == account.key }) current.map { if (it.key == account.key) account else it } else current + account)
    }

    suspend fun update(key: String, transform: (Account) -> Account): Account? = mutex.withLock {
        ensureLoaded()
        val old = state.value.firstOrNull { it.key == key } ?: return@withLock null
        val new = transform(old)
        write(state.value.map { if (it.key == key) new else it })
        new
    }

    suspend fun remove(key: String) = mutex.withLock {
        ensureLoaded()
        write(state.value.filterNot { it.key == key })
    }

    private suspend fun ensureLoaded() {
        if (loaded) return
        state.value = withContext(Dispatchers.IO) { read() }
        loaded = true
    }

    private fun read(): List<Account> {
        if (!file.exists()) return emptyList()
        return try {
            val parsed = SyncJson.decodeFromString(StoreFile.serializer(), file.readText())
            if (parsed.v == VERSION) parsed.accounts else { moveAside(); emptyList() }
        } catch (e: Exception) {
            moveAside()
            emptyList()
        }
    }

    private fun moveAside() {
        file.renameTo(File(file.parentFile, "${file.name}.corrupt-${System.currentTimeMillis()}"))
    }

    private suspend fun write(accounts: List<Account>) {
        withContext(Dispatchers.IO) {
            file.parentFile?.mkdirs()
            val tmp = File(file.parentFile, "${file.name}.tmp")
            tmp.writeText(SyncJson.encodeToString(StoreFile.serializer(), StoreFile(VERSION, accounts)))
            Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
        }
        state.value = accounts
    }

    private companion object { const val VERSION = 1 }
}
