import UIKit
import UniformTypeIdentifiers
import XCTest
@testable import Synclet

final class PhotoImportTests: XCTestCase {
    private let utc = TimeZone(identifier: "UTC")!
    /// 2026-10-16 08:30:00 UTC.
    private let date = Date(timeIntervalSince1970: 1_792_139_400)

    func testPhotoExportNaming() async throws {
        XCTAssertEqual(PhotoImport.fileName(original: nil, contentType: .heic, asJPEG: false, date: date, timeZone: utc),
                       "Foto 2026-10-16 08.30.00.heic")
        XCTAssertEqual(PhotoImport.fileName(original: nil, contentType: .heic, asJPEG: true, date: date, timeZone: utc),
                       "Foto 2026-10-16 08.30.00.jpg")
        XCTAssertEqual(PhotoImport.fileName(original: "IMG_0012.HEIC", contentType: .heic, asJPEG: false, date: date, timeZone: utc),
                       "IMG_0012.HEIC")
        XCTAssertEqual(PhotoImport.fileName(original: "IMG_0012.HEIC", contentType: .heic, asJPEG: true, date: date, timeZone: utc),
                       "IMG_0012.jpg")
        XCTAssertEqual(PhotoImport.fileName(original: "IMG_0012.JPG", contentType: .jpeg, asJPEG: true, date: date, timeZone: utc),
                       "IMG_0012.JPG")
        // Videos stay as they are.
        XCTAssertEqual(PhotoImport.fileName(original: nil, contentType: .quickTimeMovie, asJPEG: true, date: date, timeZone: utc),
                       "Foto 2026-10-16 08.30.00.mov")
    }

    func testGeneratedNamesAreNotOriginal() {
        XCTAssertNil(PhotoImport.originalName("8F3A1C2B-4D5E-4F60-8A9B-0C1D2E3F4A5B.heic"))
        XCTAssertNil(PhotoImport.originalName(".heic"))
        XCTAssertEqual(PhotoImport.originalName("IMG_0012.HEIC"), "IMG_0012.HEIC")
    }

    func testJPEGConversion() throws {
        let dir = FileManager.default.temporaryDirectory.appending(path: "photo-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let png = dir.appending(path: "in.png")
        let image = UIGraphicsImageRenderer(size: CGSize(width: 8, height: 8)).image { context in
            UIColor.red.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 8, height: 8))
        }
        try image.pngData()!.write(to: png)
        let out = dir.appending(path: "out.jpg")

        try PhotoImport.convertToJPEG(png, to: out)

        let data = try Data(contentsOf: out)
        XCTAssertEqual(Array(data.prefix(2)), [0xFF, 0xD8])
    }
}
