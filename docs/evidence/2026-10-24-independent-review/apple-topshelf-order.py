from pathlib import Path
import sys
s=Path(sys.argv[1]).read_text()
s=s[s.index('nonisolated final class TopShelfPublication:'):s.index('\nextension BrowseModel')]
Path('/tmp/pigtv-topshelf-order.swift').write_text('import Foundation\n'+s+r''' 
@main struct Repro {
 static func main() async throws {
  let gate = TopShelfPublication.shared
  let path = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  defer { try? FileManager.default.removeItem(at: path) }
  let releaseClear = DispatchSemaphore(value: 0)
  gate.retire()
  // A permissible schedule of clear's detached task: it runs after the new save.
  let clear = Task.detached {
   releaseClear.wait()
   _ = await gate.run(ifCurrent: nil) { try? FileManager.default.removeItem(at: path); return true }
  }
  let generation = gate.current
  _ = await gate.run(ifCurrent: generation) { try! Data("new account".utf8).write(to: path); return true }
  precondition(FileManager.default.fileExists(atPath: path.path))
  releaseClear.signal()
  await clear.value
  precondition(!FileManager.default.fileExists(atPath: path.path))
  print("REPRODUCED: delayed unconditional clear deleted current-generation snapshot")
 }
}
''')
