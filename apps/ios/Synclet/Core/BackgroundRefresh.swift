import BackgroundTasks
import FileProvider
import Foundation
import os
import SyncletKit

/// `BGAppRefreshTask` (spec §2.4): every ~30 min (iOS decides) the working set of every
/// domain is signalled, so the Files app picks up server changes while the app is closed.
enum BackgroundRefresh {
    static let identifier = "tech.jensk.synclet.ios.refresh"
    /// Earliest start after scheduling.
    static let interval: TimeInterval = 30 * 60

    /// Registers the launch handler; must run before the app finishes launching.
    static func register(accounts: AccountStore, domains: FileProviderDomainControlling = SystemFileProviderDomains()) {
        let registered = BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: nil) { task in
            guard let task = task as? BGAppRefreshTask else {
                task.setTaskCompleted(success: false)
                return
            }
            handle(task, accounts: accounts, domains: domains)
        }
        if !registered { Logger.app.error("background refresh: registration failed") }
    }

    static func makeRequest(now: Date = Date()) -> BGAppRefreshTaskRequest {
        let request = BGAppRefreshTaskRequest(identifier: identifier)
        request.earliestBeginDate = now.addingTimeInterval(interval)
        return request
    }

    /// Replaces any pending request with one for now + 30 min.
    static func schedule() {
        do {
            try BGTaskScheduler.shared.submit(makeRequest())
        } catch {
            Logger.app.error("background refresh: scheduling failed: \(String(describing: error), privacy: .public)")
        }
    }

    static func signalWorkingSets(domainIdentifiers: [String], domains: FileProviderDomainControlling) async {
        for identifier in domainIdentifiers {
            await domains.signalEnumerator(domainIdentifier: identifier, container: .workingSet)
        }
    }

    private static func handle(_ task: BGAppRefreshTask, accounts: AccountStore, domains: FileProviderDomainControlling) {
        schedule()
        let box = TaskBox(task)
        let work = Task {
            await signalWorkingSets(domainIdentifiers: accounts.all().map(\.key16), domains: domains)
            box.task.setTaskCompleted(success: !Task.isCancelled)
        }
        task.expirationHandler = { work.cancel() }
    }

    /// `BGTask` is thread-safe but not marked `Sendable`.
    private final class TaskBox: @unchecked Sendable {
        let task: BGTask
        init(_ task: BGTask) { self.task = task }
    }
}
