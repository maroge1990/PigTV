from pathlib import Path
import sys
source=Path(sys.argv[1]).read_text()
source=source[source.index('nonisolated final class ArtworkBudget:'):]
old='        repeat {} while budget.finished(limit: limit, removedAny: pruneOnce(maxBytes: limit).removed > 0)'
assert old in source
source=source.replace(old,'''        repeat {
            let result = pruneOnce(maxBytes: limit)
            Hook.pause()
            if !budget.finished(limit: limit, removedAny: result.removed > 0) { break }
        } while true''')
Path('/tmp/pigtv-round4-prune.swift').write_text('import Foundation\nimport CryptoKit\n'+source+'''
nonisolated enum Hook {
    nonisolated(unsafe) static var enabled = false
    static let arrived = DispatchSemaphore(value: 0)
    static let resume = DispatchSemaphore(value: 0)
    static func waitForArrival() { arrived.wait() }
    static func pause() { if enabled { arrived.signal(); resume.wait() } }
}
@main struct Repro {
    static func main() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = ArtworkDiskStore(directory: root, limit: 1500)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try Data(repeating: 1, count: 1000).write(to: store.fileURL(forKey: "first")) // previous launch cache
        Hook.enabled = true
        precondition(store.budget.begin())
        let pruning = Task.detached { store.pruneLoop() }
        await Task.detached { Hook.waitForArrival() }.value // a pass has listed 1000 bytes and removed nothing; not yet finished
        store.write(Data(repeating: 2, count: 1000), key: "second")
        Hook.enabled = false
        Hook.resume.signal()
        await pruning.value
        await store.budget.idle()
        let urls = try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: [.fileSizeKey])
        let disk = try urls.reduce(0) { try $0 + $1.resourceValues(forKeys: [.fileSizeKey]).fileSize! }
        print("disk=\\(disk) counted=\\(store.budget.counted!) limit=\\(store.limit); prune idle")
        precondition(disk == 2000 && store.budget.counted == 2000 && disk > store.limit)
    }
}
''')
