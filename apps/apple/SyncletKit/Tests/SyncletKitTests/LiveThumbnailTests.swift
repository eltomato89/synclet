#if os(macOS)
import CoreGraphics
import FileProvider
import Foundation
import ImageIO
import UniformTypeIdentifiers
import XCTest
@testable import SyncletKit

/// Opt-in live check of the thumbnail path against a running server with its derivatives
/// worker (skipped without `SYNCLET_LIVE_URL` / `_USER` / `_PASSWORD`).
///
/// Uploads a PNG and a PDF, then asks the extension's `fetchThumbnails` for them (polling
/// while the worker renders), checks the bytes are webp, that the second request is served
/// from the cache, and that a folder gets none. Deletes the files and revokes the device.
final class LiveThumbnailTests: XCTestCase {
    func testServerThumbnailsForImageAndPDF() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let urlString = env["SYNCLET_LIVE_URL"], let server = URL(string: urlString),
              let user = env["SYNCLET_LIVE_USER"], let password = env["SYNCLET_LIVE_PASSWORD"] else {
            throw XCTSkip("SYNCLET_LIVE_URL / _USER / _PASSWORD not set")
        }
        var login = URLRequest(url: server.appending(path: "api/auth/login"))
        login.httpMethod = "POST"
        login.setValue("application/json", forHTTPHeaderField: "Content-Type")
        login.httpBody = try JSONSerialization.data(withJSONObject: ["login": user, "password": password])
        let (loginData, _) = try await URLSession.shared.data(for: login)
        let accessToken = try XCTUnwrap((try JSONSerialization.jsonObject(with: loginData) as? [String: Any])?["accessToken"] as? String)
        let registration = try await SyncAPIClient(baseURL: server, token: accessToken)
            .registerDevice(name: "SyncletKit live thumbnail test", platform: .macos, appVersion: "0.1.0")
        let api = SyncAPIClient(baseURL: server, token: registration.token)
        var created: [String] = []
        do {
            try await run(api: api, created: &created)
        } catch {
            for id in created { try? await api.deleteItem(id: id) }
            try? await api.revokeCurrentDevice()
            throw error
        }
        for id in created { try await api.deleteItem(id: id) }
        try await api.revokeCurrentDevice()
    }

    /// With `SYNCLET_LIVE_MAX_UPLOAD_BYTES` set to the server's (small) `SYNCLET_MAX_UPLOAD_BYTES`:
    /// a create above the limit fails with `insufficientQuota` and reports a `too_large`
    /// problem (what the macOS extension writes to the menu's error log).
    func testTooLargeUploadIsReportedAsProblem() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let urlString = env["SYNCLET_LIVE_URL"], let server = URL(string: urlString),
              let user = env["SYNCLET_LIVE_USER"], let password = env["SYNCLET_LIVE_PASSWORD"],
              let limit = Int(env["SYNCLET_LIVE_MAX_UPLOAD_BYTES"] ?? "") else {
            throw XCTSkip("SYNCLET_LIVE_URL / _USER / _PASSWORD / _MAX_UPLOAD_BYTES not set")
        }
        var login = URLRequest(url: server.appending(path: "api/auth/login"))
        login.httpMethod = "POST"
        login.setValue("application/json", forHTTPHeaderField: "Content-Type")
        login.httpBody = try JSONSerialization.data(withJSONObject: ["login": user, "password": password])
        let (loginData, _) = try await URLSession.shared.data(for: login)
        let accessToken = try XCTUnwrap((try JSONSerialization.jsonObject(with: loginData) as? [String: Any])?["accessToken"] as? String)
        let registration = try await SyncAPIClient(baseURL: server, token: accessToken)
            .registerDevice(name: "SyncletKit live 413 test", platform: .macos, appVersion: "0.1.0")
        let api = SyncAPIClient(baseURL: server, token: registration.token)

        let temp = Fixtures.tempDirectory()
        defer { try? FileManager.default.removeItem(at: temp) }
        let file = temp.appending(path: "big.bin")
        try Data(repeating: 1, count: limit * 2 + 1024).write(to: file)
        let context = SyncletReplicatedExtension.Context(client: api, deviceName: "Live", layout: SpaceLayout(spaces: [.personal()]))
        let domain = NSFileProviderDomain(identifier: NSFileProviderDomainIdentifier("live000000000000"), displayName: "live")
        let ext = RecordingExtension(domain: domain, temporaryDirectory: temp) { context }
        let template = TemplateItem(id: "local-big", parent: NSFileProviderItemIdentifier("space:personal"),
                                    name: "live-too-large.bin", type: .data)
        let error: Error? = await withCheckedContinuation { continuation in
            _ = ext.createItem(basedOn: template, fields: [.contents], contents: file, options: [],
                               request: NSFileProviderRequest()) { _, _, _, error in continuation.resume(returning: error) }
        }
        try? await api.revokeCurrentDevice()
        print("LIVE: create above the limit → \(String(describing: error)); problems \(ext.problems)")
        XCTAssertEqual((error as NSError?)?.code, NSFileProviderError.insufficientQuota.rawValue)
        XCTAssertEqual(ext.problems.map(\.code), [.tooLarge])
        XCTAssertEqual(ext.problems.first?.fileName, "live-too-large.bin")
        XCTAssertEqual(ext.problems.first?.itemIdentifier, "local-big")
        print("LIVE: message de/en: \(ext.problems.first?.message() ?? "")")
    }

    private func run(api: SyncAPIClient, created: inout [String]) async throws {
        let tag = UUID().uuidString.prefix(8)
        let png = try await api.uploadNewFile(parentID: SyncItem.rootID, name: "live-thumb-\(tag).png", from: try Self.pngFile())
        created.append(png.id)
        let pdf = try await api.uploadNewFile(parentID: SyncItem.rootID, name: "live-thumb-\(tag).pdf", from: try Self.pdfFile())
        created.append(pdf.id)
        let folder = try await api.createFolder(parentID: SyncItem.rootID, name: "live-thumb-\(tag)")
        created.append(folder.id)
        print("LIVE: uploaded png \(png.id), pdf \(pdf.id), folder \(folder.id)")

        let layout = SpaceLayout(spaces: [.personal()])
        let context = SyncletReplicatedExtension.Context(client: api, deviceName: "Live", layout: layout)
        let domain = NSFileProviderDomain(identifier: NSFileProviderDomainIdentifier("live000000000000"), displayName: "live")
        // A fresh cache directory per attempt: the in-memory negative cache would otherwise
        // (correctly) suppress the re-ask for 10 minutes after the first 404.
        var temps: [URL] = []
        defer { temps.forEach { try? FileManager.default.removeItem(at: $0) } }
        var temp = Fixtures.tempDirectory()
        var ext = SyncletReplicatedExtension(domain: domain, temporaryDirectory: temp) { context }

        // The worker renders asynchronously: poll like a client would (§9.1), up to ~90 s.
        let ids = [png.id, pdf.id, folder.id].map { NSFileProviderItemIdentifier($0) }
        var results: [String: (data: Data?, error: Error?)] = [:]
        let started = Date()
        for attempt in 1...30 {
            results = try await fetch(ext, ids, size: CGSize(width: 300, height: 300))
            if results[png.id]?.data != nil, results[pdf.id]?.data != nil { break }
            temps.append(temp)
            temp = Fixtures.tempDirectory()
            ext = SyncletReplicatedExtension(domain: domain, temporaryDirectory: temp) { context }
            print("LIVE: attempt \(attempt): png \(results[png.id]?.data?.count ?? 0) B, pdf \(results[pdf.id]?.data?.count ?? 0) B")
            try await Task.sleep(for: .seconds(3))
        }
        print("LIVE: thumbnails after \(Int(Date().timeIntervalSince(started))) s")
        for (name, id) in [("png", png.id), ("pdf", pdf.id)] {
            let data = try XCTUnwrap(results[id]?.data, "\(name) thumbnail")
            XCTAssertNil(results[id]?.error)
            XCTAssertEqual(data.prefix(4), Data("RIFF".utf8), name)
            XCTAssertEqual(data.dropFirst(8).prefix(4), Data("WEBP".utf8), name)
            let source = try XCTUnwrap(CGImageSourceCreateWithData(data as CFData, nil))
            let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
            print("LIVE: \(name) thumbnail \(data.count) B, \(props?[kCGImagePropertyPixelWidth] ?? "?")×\(props?[kCGImagePropertyPixelHeight] ?? "?")")
        }
        XCTAssertNil(results[folder.id]?.data)
        XCTAssertNil(results[folder.id]?.error)

        temps.append(temp)

        // Cached by item id in the size bucket 256 (300 is nearer to 256 than to 1024), with
        // the server's ETag "<sha256>-256" as the validator: the server answers 304 to it.
        let cacheDir = temp.appending(path: "thumbnails").appending(path: domain.identifier.rawValue)
        let files = Set(try FileManager.default.contentsOfDirectory(atPath: cacheDir.path))
        XCTAssertTrue(files.contains(ThumbnailCache.fileName(itemID: png.id, size: 256)), "\(files)")
        let cached = try XCTUnwrap(ThumbnailCache(directory: cacheDir).entry(itemID: png.id, size: 256))
        XCTAssertEqual(cached.data, results[png.id]?.data)
        let etag = try XCTUnwrap(cached.etag)
        XCTAssertTrue(etag.hasSuffix("-256"), etag)
        print("LIVE: stored ETag \(etag)")
        do {
            _ = try await api.thumbnail(itemID: png.id, size: 256, ifNoneMatch: etag)
            XCTFail("304 expected")
        } catch SyncAPIError.notModified {
            print("LIVE: If-None-Match → 304")
        }
        let revalidated = try await fetch(ext, [ids[0]], size: CGSize(width: 300, height: 300))
        XCTAssertEqual(revalidated[png.id]?.data, cached.data)

        // The large bucket is a separate rendition.
        let large = try await fetch(ext, [ids[0]], size: CGSize(width: 1024, height: 1024))
        let largeData = try XCTUnwrap(large[png.id]?.data)
        XCTAssertNotEqual(largeData, results[png.id]?.data)
        print("LIVE: png 1024 bucket \(largeData.count) B")
    }

    private func fetch(_ ext: SyncletReplicatedExtension, _ ids: [NSFileProviderItemIdentifier],
                       size: CGSize) async throws -> [String: (data: Data?, error: Error?)] {
        let box = ResultsBox()
        let error: Error? = await withCheckedContinuation { continuation in
            _ = ext.fetchThumbnails(for: ids, requestedSize: size,
                                    perThumbnailCompletionHandler: { id, data, error in box.add(id.rawValue, data, error) },
                                    completionHandler: { continuation.resume(returning: $0) })
        }
        if let error { throw error }
        return box.all
    }

    /// A 1200×800 PNG with a gradient and a few shapes.
    static func pngFile() throws -> URL {
        let width = 1200, height = 800
        let context = try XCTUnwrap(CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                              space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.setFillColor(CGColor(red: 0.1, green: 0.4, blue: 0.8, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        context.setFillColor(CGColor(red: 1, green: 0.8, blue: 0.1, alpha: 1))
        context.fillEllipse(in: CGRect(x: 200, y: 200, width: 400, height: 400))
        context.setFillColor(CGColor(red: 0.9, green: 0.2, blue: 0.3, alpha: 1))
        context.fill(CGRect(x: 700, y: 100, width: 300, height: 600))
        let image = try XCTUnwrap(context.makeImage())
        let url = FileManager.default.temporaryDirectory.appending(path: "synclet-live-\(UUID().uuidString).png")
        let destination = try XCTUnwrap(CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(destination, image, nil)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        return url
    }

    /// A one-page A4 PDF with a coloured block.
    static func pdfFile() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appending(path: "synclet-live-\(UUID().uuidString).pdf")
        var box = CGRect(x: 0, y: 0, width: 595, height: 842)
        let context = try XCTUnwrap(CGContext(url as CFURL, mediaBox: &box, nil))
        context.beginPDFPage(nil)
        context.setFillColor(CGColor(red: 0.2, green: 0.6, blue: 0.3, alpha: 1))
        context.fill(CGRect(x: 60, y: 400, width: 475, height: 380))
        context.setFillColor(CGColor(red: 0.1, green: 0.1, blue: 0.1, alpha: 1))
        for row in 0..<12 { context.fill(CGRect(x: 60, y: 60 + row * 26, width: 400 - row * 15, height: 10)) }
        context.endPDFPage()
        context.closePDF()
        return url
    }
}
#endif
