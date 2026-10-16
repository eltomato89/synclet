import os

/// `os.Logger`s of the kit (subsystem `tech.jensk.synclet`). File names are logged
/// `.private`; tokens and headers are never logged.
enum Log {
    static let subsystem = "tech.jensk.synclet"
    static let fileProvider = Logger(subsystem: subsystem, category: "fileprovider")
    static let account = Logger(subsystem: subsystem, category: "account")
    static let transfer = Logger(subsystem: subsystem, category: "transfer")
    static let pinning = Logger(subsystem: subsystem, category: "pinning")
    static let upload = Logger(subsystem: subsystem, category: "upload")
}
