import CoreTransferable
import Foundation
import ImageIO
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// Picked photos and videos as files for the upload queue: the original (HEIC, MOV …) or,
/// with the setting "Upload Photos as JPEG", photos converted to JPEG.
enum PhotoImport {
    /// The picker's file, copied out of the transfer (whose file disappears afterwards).
    struct ImportedFile: Transferable {
        let url: URL

        static var transferRepresentation: some TransferRepresentation {
            FileRepresentation(importedContentType: .item) { received in
                let directory = FileManager.default.temporaryDirectory
                    .appending(path: "photo-received-\(UUID().uuidString)", directoryHint: .isDirectory)
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                let target = directory.appending(path: received.file.lastPathComponent, directoryHint: .notDirectory)
                try FileManager.default.copyItem(at: received.file, to: target)
                return ImportedFile(url: target)
            }
        }
    }

    enum ExportError: Error {
        case noFile
        case conversionFailed
    }

    /// Writes the item into its own folder below `dir` and returns the file. Keeps the original
    /// file name when the picker provides one, otherwise "Photo <yyyy-MM-dd HH.mm.ss>.<ext>".
    static func export(_ item: PhotosPickerItem, asJPEG: Bool, to dir: URL) async throws -> URL {
        guard let imported = try await item.loadTransferable(type: ImportedFile.self) else { throw ExportError.noFile }
        let fm = FileManager.default
        defer { try? fm.removeItem(at: imported.url.deletingLastPathComponent()) }
        let type = UTType(filenameExtension: imported.url.pathExtension) ?? item.supportedContentTypes.first ?? .data
        let name = fileName(original: originalName(imported.url.lastPathComponent), contentType: type,
                            asJPEG: asJPEG, date: Date())
        let folder = dir.appending(path: UUID().uuidString, directoryHint: .isDirectory)
        try fm.createDirectory(at: folder, withIntermediateDirectories: true)
        let target = folder.appending(path: name, directoryHint: .notDirectory)
        if needsJPEG(type, asJPEG: asJPEG) {
            try convertToJPEG(imported.url, to: target)
        } else {
            try fm.moveItem(at: imported.url, to: target)
        }
        return target
    }

    /// Only still images that are not JPEG already are converted; videos stay as they are.
    static func needsJPEG(_ type: UTType, asJPEG: Bool) -> Bool {
        asJPEG && type.conforms(to: .image) && !type.conforms(to: .jpeg)
    }

    static func fileName(original: String?, contentType: UTType, asJPEG: Bool, date: Date,
                         timeZone: TimeZone = .current) -> String {
        let jpeg = needsJPEG(contentType, asJPEG: asJPEG)
        if let original {
            return jpeg ? (original as NSString).deletingPathExtension + ".jpg" : original
        }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = timeZone
        formatter.dateFormat = "yyyy-MM-dd HH.mm.ss"
        let ext = jpeg ? "jpg" : (contentType.preferredFilenameExtension ?? "dat")
        return "Foto \(formatter.string(from: date)).\(ext)"
    }

    /// The picker's file name when it is a real one (not a generated UUID or empty).
    static func originalName(_ fileName: String) -> String? {
        let base = (fileName as NSString).deletingPathExtension
        guard !base.isEmpty, !fileName.hasPrefix("."), UUID(uuidString: base) == nil else { return nil }
        return fileName
    }

    /// The primary image of `source` as JPEG (metadata kept), streamed by ImageIO.
    static func convertToJPEG(_ source: URL, to target: URL) throws {
        guard let image = CGImageSourceCreateWithURL(source as CFURL, nil),
              let destination = CGImageDestinationCreateWithURL(target as CFURL, UTType.jpeg.identifier as CFString, 1, nil)
        else { throw ExportError.conversionFailed }
        let options = [kCGImageDestinationLossyCompressionQuality: 0.9] as CFDictionary
        CGImageDestinationAddImageFromSource(destination, image, CGImageSourceGetPrimaryImageIndex(image), options)
        guard CGImageDestinationFinalize(destination) else { throw ExportError.conversionFailed }
    }
}
