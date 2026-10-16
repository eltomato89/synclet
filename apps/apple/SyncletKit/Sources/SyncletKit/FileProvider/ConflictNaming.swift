import Foundation

/// Names of conflict copies (spec §2.7):
/// `"<base> (Konflikt <device> <yyyy-MM-dd HH-mm>).<ext>"`.
public enum ConflictNaming {
    /// Name of the conflict copy of `original`, created on `device` at `date`
    /// (time in `timeZone`, default: local).
    public static func name(original: String, device: String, date: Date, timeZone: TimeZone = .current) -> String {
        let (base, ext) = split(original)
        let suffix = " (Konflikt \(sanitizedDeviceName(device)) \(timestamp(date, timeZone: timeZone)))"
        if let ext { return base + suffix + "." + ext }
        return base + suffix
    }

    /// Splits a file name into base and extension (without the dot) at the last dot.
    /// Leading dots (`.profile`), a trailing dot and names without a dot have no extension.
    public static func split(_ name: String) -> (base: String, ext: String?) {
        guard let dot = name.lastIndex(of: "."), dot != name.startIndex,
              name.index(after: dot) != name.endIndex else {
            return (name, nil)
        }
        return (String(name[..<dot]), String(name[name.index(after: dot)...]))
    }

    /// `yyyy-MM-dd HH-mm` in the given time zone.
    public static func timestamp(_ date: Date, timeZone: TimeZone = .current) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let c = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: date)
        return String(format: "%04d-%02d-%02d %02d-%02d",
                      c.year ?? 0, c.month ?? 0, c.day ?? 0, c.hour ?? 0, c.minute ?? 0)
    }

    /// Device name without path separators and colons (`/`, `\`, `:` → `-`), trimmed.
    public static func sanitizedDeviceName(_ deviceName: String) -> String {
        let cleaned = deviceName
            .map { "/\\:".contains($0) ? "-" : $0 }
            .reduce(into: "") { $0.append($1) }
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return cleaned.isEmpty ? "Mac" : cleaned
    }
}
