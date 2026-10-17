package tech.jensk.synclet.core.api

import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import okhttp3.MediaType
import okhttp3.RequestBody
import okio.BufferedSink

/** Streams [length] bytes of [file] from [offset]; reports the bytes written so far. */
class FileRangeBody(
    private val file: File,
    private val offset: Long = 0,
    private val length: Long = file.length() - offset,
    private val type: MediaType,
    private val onProgress: (Long) -> Unit = {},
) : RequestBody() {
    override fun contentType(): MediaType = type
    override fun contentLength(): Long = length
    override fun writeTo(sink: BufferedSink) {
        RandomAccessFile(file, "r").use { raf ->
            raf.seek(offset)
            val buffer = ByteArray(64 * 1024)
            var left = length
            var sent = 0L
            while (left > 0) {
                val n = raf.read(buffer, 0, minOf(buffer.size.toLong(), left).toInt())
                if (n < 0) throw IOException("${file.name} is shorter than expected")
                sink.write(buffer, 0, n)
                left -= n
                sent += n
                onProgress(sent)
            }
        }
    }
}
