import Foundation

/// One dispatched Server-Sent Event.
public struct SSEEvent: Sendable, Hashable {
    /// The `event:` field; `"message"` when the block had none.
    public var event: String
    /// The `data:` lines joined with `\n` (without the final line feed).
    public var data: String
    /// The last event id (`id:`) seen on the stream so far; `nil` while none was set.
    public var id: String?
    /// The `retry:` value (milliseconds) of this event's block, if it had one.
    public var retry: Int?

    public init(event: String = "message", data: String, id: String? = nil, retry: Int? = nil) {
        self.event = event
        self.data = data
        self.id = id
        self.retry = retry
    }
}

/// Incremental parser of a `text/event-stream` body (WHATWG HTML, "Server-sent events",
/// §9.2.6 "Interpreting an event stream").
///
/// Pure and chunk-agnostic: bytes may be split anywhere (inside a field, a UTF-8 sequence,
/// a CRLF or the BOM). Lines end with CRLF, LF or CR; `:` lines are comments; several
/// `data:` lines are joined with `\n`; a block without data dispatches nothing. An
/// unterminated block at the end of the stream is discarded, as the standard says.
public struct SSEParser: Sendable {
    /// Bytes of the current, unterminated line.
    private var line: [UInt8] = []
    /// The previous chunk ended with CR: a LF at the start of the next one belongs to it.
    private var pendingCR = false
    /// Bytes seen at the very start of the stream while checking for a BOM.
    private var head: [UInt8] = []
    private var headDone = false

    // Buffers of the block being read.
    private var eventType = ""
    private var dataBuffer = ""
    private var hasData = false
    private var blockRetry: Int?

    /// Last event id (persists across blocks, as the standard says).
    public private(set) var lastEventId = ""
    /// The reconnection time (milliseconds) of the most recent valid `retry:` field.
    public private(set) var retry: Int?

    public init() {}

    /// Feeds the next bytes and returns the events completed by them.
    public mutating func feed(_ bytes: Data) -> [SSEEvent] {
        var events: [SSEEvent] = []
        var input = Array(bytes)
        if !headDone {
            // UTF-8 BOM (EF BB BF) at the very start, possibly split across chunks.
            head += input
            let bom: [UInt8] = [0xEF, 0xBB, 0xBF]
            if head.count < bom.count, Array(bom.prefix(head.count)) == head { return [] }
            headDone = true
            input = head.starts(with: bom) ? Array(head.dropFirst(bom.count)) : head
            head = []
        }
        for byte in input {
            if pendingCR {
                pendingCR = false
                if byte == 0x0A { continue }   // CRLF split across chunks (or just CRLF)
            }
            switch byte {
            case 0x0D:
                pendingCR = true
                endLine(into: &events)
            case 0x0A:
                endLine(into: &events)
            default:
                line.append(byte)
            }
        }
        return events
    }

    private mutating func endLine(into events: inout [SSEEvent]) {
        let text = String(decoding: line, as: UTF8.self)
        line.removeAll(keepingCapacity: true)
        if text.isEmpty {
            dispatch(into: &events)
            return
        }
        if text.hasPrefix(":") { return }   // comment (`: ping`)
        let field: Substring
        var value: Substring
        if let colon = text.firstIndex(of: ":") {
            field = text[..<colon]
            value = text[text.index(after: colon)...]
            if value.hasPrefix(" ") { value = value.dropFirst() }
        } else {
            field = Substring(text)
            value = ""
        }
        switch field {
        case "event":
            eventType = String(value)
        case "data":
            if hasData { dataBuffer += "\n" }
            dataBuffer += value
            hasData = true
        case "id":
            if !value.contains("\u{0}") { lastEventId = String(value) }
        case "retry":
            if !value.isEmpty, value.allSatisfy({ $0.isASCII && $0.isNumber }), let ms = Int(value) {
                retry = ms
                blockRetry = ms
            }
        default:
            break   // unknown fields are ignored
        }
    }

    private mutating func dispatch(into events: inout [SSEEvent]) {
        defer {
            eventType = ""
            dataBuffer = ""
            hasData = false
            blockRetry = nil
        }
        guard hasData else { return }
        events.append(SSEEvent(event: eventType.isEmpty ? "message" : eventType, data: dataBuffer,
                               id: lastEventId.isEmpty ? nil : lastEventId, retry: blockRetry))
    }
}
