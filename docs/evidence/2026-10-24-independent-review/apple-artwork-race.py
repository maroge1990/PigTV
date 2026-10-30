from pathlib import Path
import sys
source=Path(sys.argv[1]).read_text()
source=source[source.index('nonisolated final class ArtworkBudget:'):]
needle='        guard (try? data.write(to: url, options: .atomic)) != nil else { return }'
assert needle in source
source=source.replace(needle,'        Hook.pause(key) // review-only scheduling barrier; no cache behavior changed\n'+needle)
Path('/tmp/pigtv-artwork-race.swift').write_text('import Foundation\nimport CryptoKit\n'+source+'''
nonisolated enum Hook {
    nonisolated(unsafe) static var enabled = false
    static let arrived = DispatchSemaphore(value: 0)
    static let resume = DispatchSemaphore(value: 0)
    static func pause(_ key: String) {
        if key == "old" && enabled { arrived.signal(); resume.wait() }
    }
}
@main struct Repro {
    static func main() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = ArtworkDiskStore(directory: root, limit: 1500)
        store.write(Data(repeating: 1, count: 1000), key: "old")
        await store.budget.idle()
        _ = store.read(key: "old", now: Date().addingTimeInterval(-60))
        Hook.enabled = true
        let writer = Task.detached { store.write(Data(repeating: 2, count: 1000), key: "old") }
        Hook.arrived.wait() // old size captured; replacement has not published
        store.write(Data(repeating: 3, count: 1000), key: "new")
        await store.budget.idle() // crossing cap prunes the old file
        precondition(!FileManager.default.fileExists(atPath: store.fileURL(forKey: "old").path))
        Hook.resume.signal()
        await writer.value
        await store.budget.idle()
        let files = try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: [.fileSizeKey])
        let disk = try files.reduce(0) { try $0 + $1.resourceValues(forKeys: [.fileSizeKey]).fileSize! }
        print("REPRODUCED: disk=\\(disk) counted=\\(store.budget.counted!) limit=\\(store.limit), prune idle")
        precondition(disk == 2000 && store.budget.counted == 1000 && disk > store.limit)
    }
}
''')
