from pathlib import Path
import sys
source=Path(sys.argv[1]).read_text()
source=source[source.index('nonisolated final class ArtworkBudget:'):]
old='''    private func remove(_ url: URL) -> Bool {
        budget.change { () -> (Bool, Int) in'''
assert old in source
source=source.replace(old,'''    private func remove(_ url: URL) -> Bool {
        Hook.pause()
        return budget.change { () -> (Bool, Int) in''')
Path('/tmp/pigtv-r5-cached-size.swift').write_text('import Foundation\nimport CryptoKit\n'+source+'''
nonisolated enum Hook {
 static let arrived = DispatchSemaphore(value: 0)
 static let resume = DispatchSemaphore(value: 0)
 nonisolated(unsafe) static var first = true
 static func pause() { if first { first = false; arrived.signal(); resume.wait() } }
}
@main struct Repro {
 static func main() async throws {
  let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  defer {try? FileManager.default.removeItem(at:root)}
  try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true)
  let store = ArtworkDiskStore(directory:root,limit:1500)
  try Data(repeating:1,count:2000).write(to:store.fileURL(forKey:"a"),options:.atomic)
  precondition(store.budget.begin())
  let task=Task.detached {store.pruneLoop()}
  await Task.detached {Hook.arrived.wait()}.value
  store.write(Data(repeating:2,count:500),key:"a")
  Hook.resume.signal()
  await task.value
  await store.budget.idle()
  print("after removal: counted=\\(store.budget.counted!)")
  store.write(Data(repeating:3,count:2000),key:"b")
  await store.budget.idle()
  let urls=try FileManager.default.contentsOfDirectory(at:root,includingPropertiesForKeys:[.fileSizeKey])
  let disk=try urls.reduce(0) {try $0+$1.resourceValues(forKeys:[.fileSizeKey]).fileSize!}
  print("REPRODUCED: disk=\\(disk) counted=\\(store.budget.counted!) limit=\\(store.limit); prune idle")
  precondition(disk==2000 && store.budget.counted==500)
 }
}
''')
