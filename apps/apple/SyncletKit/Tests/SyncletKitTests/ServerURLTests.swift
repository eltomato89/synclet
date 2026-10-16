import XCTest
@testable import SyncletKit

final class ServerURLTests: XCTestCase {
    private func normalized(_ input: String) throws -> String {
        try ServerURL.normalize(input).absoluteString
    }

    func testAddsHTTPSWithoutScheme() throws {
        XCTAssertEqual(try normalized("synclet.dw83.de"), "https://synclet.dw83.de")
    }

    func testStripsTrailingSlashPathQueryAndWhitespace() throws {
        XCTAssertEqual(try normalized("https://synclet.dw83.de/"), "https://synclet.dw83.de")
        XCTAssertEqual(try normalized("  https://Files.Example.com/app/files?x=1#top \n"), "https://files.example.com")
    }

    func testKeepsPort() throws {
        XCTAssertEqual(try normalized("synclet.example.com:8443/"), "https://synclet.example.com:8443")
    }

    func testLocalhostHTTPAllowed() throws {
        XCTAssertEqual(try normalized("http://localhost:8080/"), "http://localhost:8080")
        XCTAssertEqual(try normalized("http://127.0.0.1"), "http://127.0.0.1")
    }

    func testPrivateIPsHTTPAllowed() throws {
        XCTAssertEqual(try normalized("http://192.168.1.10:3000/api"), "http://192.168.1.10:3000")
        XCTAssertEqual(try normalized("http://10.0.0.5"), "http://10.0.0.5")
        XCTAssertEqual(try normalized("http://172.20.1.1"), "http://172.20.1.1")
    }

    func testFTPThrows() {
        XCTAssertThrowsError(try ServerURL.normalize("ftp://x")) { XCTAssertEqual($0 as? ServerURLError, .invalid) }
    }

    func testPublicIPOverHTTPThrows() {
        XCTAssertThrowsError(try ServerURL.normalize("http://8.8.8.8")) { XCTAssertEqual($0 as? ServerURLError, .invalid) }
        XCTAssertThrowsError(try ServerURL.normalize("http://172.32.0.1"))
    }

    func testPublicHostOverHTTPThrows() {
        XCTAssertThrowsError(try ServerURL.normalize("http://synclet.dw83.de"))
    }

    func testEmptyAndGarbageThrow() {
        XCTAssertThrowsError(try ServerURL.normalize(""))
        XCTAssertThrowsError(try ServerURL.normalize("   "))
        XCTAssertThrowsError(try ServerURL.normalize("https://"))
        XCTAssertThrowsError(try ServerURL.normalize("not a host"))
    }

    func testHTTPSWithIPAllowed() throws {
        XCTAssertEqual(try normalized("https://8.8.8.8"), "https://8.8.8.8")
    }

    func testDropsUserInfo() throws {
        XCTAssertEqual(try normalized("https://user:pw@synclet.dw83.de"), "https://synclet.dw83.de")
    }

    func testDisplayHost() throws {
        XCTAssertEqual(ServerURL.displayHost(try ServerURL.normalize("synclet.dw83.de")), "synclet.dw83.de")
        XCTAssertEqual(ServerURL.displayHost(try ServerURL.normalize("http://localhost:8080")), "localhost:8080")
    }
}
