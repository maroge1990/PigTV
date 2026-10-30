from pathlib import Path
import sys
source=Path(sys.argv[1]).read_text();source=source[source.index('nonisolated final class ArtworkBudget:'):]
if len(sys.argv)>2:
 source=source.replace('if (bytes ?? 0) > limit, removedAny || grew { return (true, []) }','if (bytes ?? 0) > limit, removedAny { _ = grew; return (true, []) }')
Path('/tmp/pigtv-r5-prune-proof.swift').write_text('import Foundation\nimport CryptoKit\n'+source+'''
nonisolated enum Hook {
 static let arrived=DispatchSemaphore(value:0), resume=DispatchSemaphore(value:0)
 static let lock=NSLock()
 nonisolated(unsafe) static var used=false
 static func pause(){let first=lock.withLock{if used{return false};used=true;return true};if first{arrived.signal();resume.wait()}}
}
@main struct Repro {
 static func main() async throws {
  let root=FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  defer {try? FileManager.default.removeItem(at:root)}
  try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true)
  let store=ArtworkDiskStore(directory:root.appendingPathComponent("growth"),limit:1500)
  try FileManager.default.createDirectory(at:store.directory,withIntermediateDirectories:true)
  try Data(repeating:1,count:1000).write(to:store.fileURL(forKey:"a"))
  ArtworkBudget.afterPass={Hook.pause()};precondition(store.budget.begin())
  let pruning=Task.detached{store.pruneLoop()}
  await Task.detached{Hook.arrived.wait()}.value
  store.write(Data(repeating:2,count:1000),key:"b")
  Hook.resume.signal();await pruning.value;await store.budget.idle();ArtworkBudget.afterPass=nil
  let urls=try FileManager.default.contentsOfDirectory(at:store.directory,includingPropertiesForKeys:[.fileSizeKey])
  let disk=try urls.reduce(0){try $0+$1.resourceValues(forKeys:[.fileSizeKey]).fileSize!}
  print("growth disk=\\(disk) counted=\\(store.budget.counted!) cap=1500; idle")
  let locked=root.appendingPathComponent("locked");try FileManager.default.createDirectory(at:locked,withIntermediateDirectories:true)
  for key in ["a","b","c"]{try Data(repeating:1,count:1000).write(to:locked.appendingPathComponent(key))}
  try FileManager.default.setAttributes([.posixPermissions:0o555],ofItemAtPath:locked.path)
  defer{try? FileManager.default.setAttributes([.posixPermissions:0o755],ofItemAtPath:locked.path)}
  let guardStore=ArtworkDiskStore(directory:locked,limit:1500);precondition(guardStore.budget.begin())
  let t=Date();guardStore.pruneLoop();await guardStore.budget.idle()
  print("locked prunes=\\(guardStore.budget.prunes) counted=\\(guardStore.budget.counted!) elapsed=\\(Date().timeIntervalSince(t))s")
  precondition(guardStore.budget.prunes==1 && guardStore.budget.counted==3000)
 }
}
''')
