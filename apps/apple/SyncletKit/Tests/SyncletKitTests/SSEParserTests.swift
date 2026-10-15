import Foundation
import XCTest
@testable import SyncletKit

final class SSEParserTests: XCTestCase {
    private struct Case {
        let name: String
        let chunks: [String]
        let expected: [SSEEvent]
    }

    private static let cases: [Case] = [
        Case(name: "hello (LF)",
             chunks: ["event: hello\ndata: {\"cursor\":\"1234\"}\n\n"],
             expected: [SSEEvent(event: "hello", data: #"{"cursor":"1234"}"#)]),
        Case(name: "CRLF line endings",
             chunks: ["event: changes\r\ndata: {\"space\":\"personal\",\"cursor\":\"1240\"}\r\n\r\n"],
             expected: [SSEEvent(event: "changes", data: #"{"space":"personal","cursor":"1240"}"#)]),
        Case(name: "CR-only line endings",
             chunks: ["event: hello\rdata: x\r\r"],
             expected: [SSEEvent(event: "hello", data: "x")]),
        Case(name: "multi-line data joined with LF",
             chunks: ["data: one\ndata: two\ndata:three\n\n"],
             expected: [SSEEvent(event: "message", data: "one\ntwo\nthree")]),
        Case(name: "comment (ping) only dispatches nothing",
             chunks: [": ping\n\n", ":\n\n"],
             expected: []),
        Case(name: "comment between fields is ignored",
             chunks: ["event: hello\n: ping\ndata: a\n\n"],
             expected: [SSEEvent(event: "hello", data: "a")]),
        Case(name: "split in the middle of `data:`",
             chunks: ["event: changes\nda", "ta: {\"space\":\"pers", "onal\",\"cursor\":\"9\"}\n", "\n"],
             expected: [SSEEvent(event: "changes", data: #"{"space":"personal","cursor":"9"}"#)]),
        Case(name: "split in the middle of a CRLF",
             chunks: ["event: hello\r", "\ndata: a\r", "\n\r", "\n"],
             expected: [SSEEvent(event: "hello", data: "a")]),
        Case(name: "missing trailing newline waits for the next chunk",
             chunks: ["event: hello\ndata: a", "bc\n", "\n"],
             expected: [SSEEvent(event: "hello", data: "abc")]),
        Case(name: "unterminated block at the end is not dispatched",
             chunks: ["event: hello\ndata: a\n"],
             expected: []),
        Case(name: "BOM at the start is skipped",
             chunks: ["\u{FEFF}event: hello\ndata: a\n\n"],
             expected: [SSEEvent(event: "hello", data: "a")]),
        Case(name: "event type resets after each block; default is message",
             chunks: ["event: hello\ndata: 1\n\ndata: 2\n\n"],
             expected: [SSEEvent(event: "hello", data: "1"), SSEEvent(event: "message", data: "2")]),
        Case(name: "block without data dispatches nothing and resets the type",
             chunks: ["event: hello\n\ndata: x\n\n"],
             expected: [SSEEvent(event: "message", data: "x")]),
        Case(name: "only one leading space is stripped; no colon = empty value",
             chunks: ["data:  two spaces\ndata\n\n"],
             expected: [SSEEvent(event: "message", data: " two spaces\n")]),
        Case(name: "empty data line dispatches an empty event",
             chunks: ["event: ping\ndata:\n\n"],
             expected: [SSEEvent(event: "ping", data: "")]),
        Case(name: "id persists, retry belongs to its block, unknown fields ignored",
             chunks: ["id: 7\nretry: 1500\nfoo: bar\ndata: a\n\ndata: b\n\n"],
             expected: [SSEEvent(event: "message", data: "a", id: "7", retry: 1500),
                        SSEEvent(event: "message", data: "b", id: "7", retry: nil)]),
        Case(name: "invalid retry is ignored",
             chunks: ["retry: 1s\ndata: a\n\n"],
             expected: [SSEEvent(event: "message", data: "a")]),
        Case(name: "full server stream",
             chunks: ["event: hello\ndata: {\"cursor\":\"1\"}\n\n: ping\n\nevent: changes\ndata: {\"space\":\"personal\",\"cursor\":\"2\"}\n\nevent: bye\ndata: {\"reason\":\"server_shutdown\"}\n\n"],
             expected: [SSEEvent(event: "hello", data: #"{"cursor":"1"}"#),
                        SSEEvent(event: "changes", data: #"{"space":"personal","cursor":"2"}"#),
                        SSEEvent(event: "bye", data: #"{"reason":"server_shutdown"}"#)]),
    ]

    func testTable() {
        for testCase in Self.cases {
            var parser = SSEParser()
            var events: [SSEEvent] = []
            for chunk in testCase.chunks { events += parser.feed(Data(chunk.utf8)) }
            XCTAssertEqual(events, testCase.expected, testCase.name)
        }
    }

    func testTableFedByteByByte() {
        for testCase in Self.cases {
            var parser = SSEParser()
            var events: [SSEEvent] = []
            for byte in Data(testCase.chunks.joined().utf8) { events += parser.feed(Data([byte])) }
            XCTAssertEqual(events, testCase.expected, "byte by byte: \(testCase.name)")
        }
    }

    func testBOMSplitAcrossChunks() {
        var parser = SSEParser()
        XCTAssertEqual(parser.feed(Data([0xEF])), [])
        XCTAssertEqual(parser.feed(Data([0xBB])), [])
        XCTAssertEqual(parser.feed(Data([0xBF]) + Data("data: a\n\n".utf8)), [SSEEvent(data: "a")])
    }

    func testUTF8SequenceSplitAcrossChunks() {
        let bytes = Array("data: Größe\n\n".utf8)
        let split = bytes.firstIndex(of: 0xC3)! + 1   // inside the two-byte "ö"
        var parser = SSEParser()
        XCTAssertEqual(parser.feed(Data(bytes[..<split])), [])
        XCTAssertEqual(parser.feed(Data(bytes[split...])), [SSEEvent(data: "Größe")])
    }

    func testRetryWithoutDataIsRemembered() {
        var parser = SSEParser()
        XCTAssertEqual(parser.feed(Data("retry: 2500\n\n".utf8)), [])
        XCTAssertEqual(parser.retry, 2500)
    }
}
