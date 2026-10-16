import Foundation

/// Downloads file content (`GET /items/:id/content`, SYNC_API.md §6.1) by streaming it into
/// a file, and resumes after network errors with `Range: bytes=<have>-` and
/// `If-Range: "<etag>"`.
///
/// - Up to `maxAttempts` attempts in total; only network errors are retried.
/// - A `200` instead of `206` (the content changed, so `If-Range` no longer matched) restarts
///   the file from byte 0. Bytes are never spliced across versions.
/// - Without an `ETag` from the first response a resume also starts over.
/// - `progress.totalUnitCount` = content size, `completedUnitCount` = bytes on disk.
public final class RangeDownloader: Sendable {
    public let api: SyncAPIClient
    public let maxAttempts: Int
    public let retryDelay: Duration
    private let sleep: @Sendable (Duration) async throws -> Void

    public init(api: SyncAPIClient, maxAttempts: Int = 3, retryDelay: Duration = .seconds(1),
                sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }) {
        self.api = api
        self.maxAttempts = max(1, maxAttempts)
        self.retryDelay = retryDelay
        self.sleep = sleep
    }

    /// Downloads the content of `itemID` into `destination` (created or overwritten).
    /// `etag` of the result is the `contentEtag` of the downloaded bytes (unquoted).
    public func download(itemID: String, to destination: URL, progress: Progress? = nil) async throws -> SyncDownloadResult {
        let fm = FileManager.default
        if fm.fileExists(atPath: destination.path) { try fm.removeItem(at: destination) }
        guard fm.createFile(atPath: destination.path, contents: nil) else { throw CocoaError(.fileWriteUnknown) }
        let handle = try FileHandle(forWritingTo: destination)
        defer { try? handle.close() }

        let url = try api.makeURL(["sync", "v1", "items", itemID, "content"])
        var etag: String?
        var have: Int64 = 0
        var failures = 0
        while true {
            try Task.checkCancellation()
            var request = URLRequest(url: url)
            request.httpMethod = "GET"
            request.setValue("*/*", forHTTPHeaderField: "Accept")
            request.cachePolicy = .reloadIgnoringLocalCacheData
            if have > 0, let etag {
                request.setValue("bytes=\(have)-", forHTTPHeaderField: "Range")
                request.setValue(SyncAPIClient.quoted(etag), forHTTPHeaderField: "If-Range")
            } else if have > 0 {
                try Self.truncate(handle, to: 0)
                have = 0
            }
            try await api.authorize(&request)

            let stream = StreamingTask(handle: handle, resumeOffset: have, progress: progress)
            let outcome = await stream.run(request, configuration: api.session.configuration)
            if let response = outcome.response {
                if response.statusCode == 200 || response.statusCode == 206 {
                    etag = response.value(forHTTPHeaderField: "ETag").map(SyncAPIClient.unquoted)
                }
            }
            have = stream.bytesOnDisk

            switch outcome.result {
            case .success(let response) where response.statusCode == 200 || response.statusCode == 206:
                if let total = stream.expectedTotal, have < total {
                    // Connection closed early without an error: resume like a network error.
                    failures += 1
                    if failures >= maxAttempts { throw SyncAPIError.transport(.networkConnectionLost, message: "incomplete download") }
                    try await sleep(retryDelay)
                    continue
                }
                progress?.completedUnitCount = progress?.totalUnitCount ?? have
                return SyncDownloadResult(fileURL: destination, etag: etag, statusCode: response.statusCode,
                                          mime: response.value(forHTTPHeaderField: "Content-Type"))
            case .success(let response):
                if response.statusCode == 304 { throw SyncAPIError.notModified }
                if response.statusCode == 416, have > 0, failures + 1 < maxAttempts {
                    // The resume offset is not satisfiable (file shrank meanwhile): start over.
                    failures += 1
                    try Self.truncate(handle, to: 0)
                    have = 0
                    etag = nil
                    continue
                }
                throw SyncAPIClient.error(response, data: stream.errorBody)
            case .failure(let error):
                if error is CancellationError { throw error }
                guard case SyncAPIError.transport = error else { throw error }
                if let response = outcome.response, response.statusCode == 200 || response.statusCode == 206,
                   let total = stream.expectedTotal, have == total {
                    // Every byte arrived before the connection dropped: complete.
                    progress?.completedUnitCount = progress?.totalUnitCount ?? have
                    return SyncDownloadResult(fileURL: destination, etag: etag, statusCode: response.statusCode,
                                              mime: response.value(forHTTPHeaderField: "Content-Type"))
                }
                failures += 1
                if failures >= maxAttempts { throw error }
                Log.transfer.info("download interrupted at \(have, privacy: .public), resuming")
                try await sleep(retryDelay)
            }
        }
    }

    static func truncate(_ handle: FileHandle, to size: Int64) throws {
        try handle.truncate(atOffset: UInt64(size))
        try handle.seek(toOffset: UInt64(size))
    }
}

/// One GET streamed into a file handle by a `URLSessionDataDelegate`.
private final class StreamingTask: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    struct Outcome {
        var response: HTTPURLResponse?
        var result: Result<HTTPURLResponse, Error>
    }

    private let handle: FileHandle
    private let progress: Progress?
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Outcome, Never>?
    private var response: HTTPURLResponse?
    private var writeError: Error?
    private var writing = false
    private(set) var bytesOnDisk: Int64
    private(set) var expectedTotal: Int64?
    private(set) var errorBody = Data()

    init(handle: FileHandle, resumeOffset: Int64, progress: Progress?) {
        self.handle = handle
        self.bytesOnDisk = resumeOffset
        self.progress = progress
    }

    func run(_ request: URLRequest, configuration: URLSessionConfiguration) async -> Outcome {
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        let task = session.dataTask(with: request)
        return await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                lock.withLock { self.continuation = continuation }
                task.resume()
            }
        } onCancel: {
            task.cancel()
        }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let http = response as? HTTPURLResponse else {
            completionHandler(.cancel)
            return
        }
        lock.withLock { self.response = http }
        do {
            switch http.statusCode {
            case 200:
                // Whole content (also when If-Range did not match): start over.
                try RangeDownloader.truncate(handle, to: 0)
                bytesOnDisk = 0
                expectedTotal = http.expectedContentLength >= 0 ? http.expectedContentLength : nil
                writing = true
            case 206:
                // Content-Range: bytes a-b/size; a must be where the file ends.
                let range = http.value(forHTTPHeaderField: "Content-Range") ?? ""
                guard let (start, total) = Self.parseContentRange(range), start == bytesOnDisk else {
                    try RangeDownloader.truncate(handle, to: 0)
                    bytesOnDisk = 0
                    writeError = SyncAPIError.transport(.cannotParseResponse, message: "unexpected Content-Range \(range)")
                    completionHandler(.cancel)
                    return
                }
                try handle.seek(toOffset: UInt64(start))
                expectedTotal = total
                writing = true
            default:
                writing = false
            }
        } catch {
            writeError = error
            completionHandler(.cancel)
            return
        }
        if writing, let total = expectedTotal, let progress {
            progress.totalUnitCount = total
            progress.completedUnitCount = bytesOnDisk
        }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard writing else {
            errorBody.append(data)
            return
        }
        do {
            try handle.write(contentsOf: data)
            bytesOnDisk += Int64(data.count)
            progress?.completedUnitCount = bytesOnDisk
        } catch {
            writeError = error
            dataTask.cancel()
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let (continuation, response) = lock.withLock { () -> (CheckedContinuation<Outcome, Never>?, HTTPURLResponse?) in
            defer { self.continuation = nil }
            return (self.continuation, self.response)
        }
        let result: Result<HTTPURLResponse, Error>
        if let writeError {
            result = .failure(writeError)
        } else if let error {
            if let urlError = error as? URLError {
                result = .failure(urlError.code == .cancelled ? CancellationError()
                                  : SyncAPIError.transport(urlError.code, message: urlError.localizedDescription))
            } else {
                result = .failure(SyncAPIError.transport(.unknown, message: String(describing: error)))
            }
        } else if let response {
            result = .success(response)
        } else {
            result = .failure(SyncAPIError.invalidResponse("Not an HTTP response"))
        }
        continuation?.resume(returning: Outcome(response: response, result: result))
    }

    /// `bytes a-b/size` → (a, size).
    static func parseContentRange(_ value: String) -> (Int64, Int64)? {
        let trimmed = value.trimmingCharacters(in: .whitespaces)
        guard trimmed.hasPrefix("bytes ") else { return nil }
        let parts = trimmed.dropFirst(6).split(separator: "/")
        guard parts.count == 2, let total = Int64(parts[1]) else { return nil }
        let range = parts[0].split(separator: "-")
        guard range.count == 2, let start = Int64(range[0]) else { return nil }
        return (start, total)
    }
}
