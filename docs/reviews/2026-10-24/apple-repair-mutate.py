# Restores build 51's ordering inside the build-53 code (hooks kept so the new tests compile).
import sys, pathlib
root = pathlib.Path(sys.argv[1])
p = root/'PigTV/TopShelfExport.swift'; s = p.read_text()
old = "        TopShelfPublication.shared.queueNow {\n"
assert old in s
s = s.replace(old, "        Task.detached(priority: .utility) { _ = await TopShelfPublication.shared.run(ifCurrent: nil, label: \"clear\") { () -> Bool in\n", 1)
old = "            contentChanged()\n        }\n    }\n\n    nonisolated static func contentChanged() {"
assert old in s
s = s.replace(old, "            contentChanged()\n            return true\n        } }\n    }\n\n    nonisolated static func contentChanged() {", 1)
p.write_text(s)
p = root/'PigTV/PrivateCaches.swift'; s = p.read_text()
old = """        if !files.try() {
            Self.waitingForFiles?()
            files.lock()
        }
        defer { files.unlock() }
        return body()"""
assert old in s
s = s.replace(old, "        return body() // mutation: no single owner of folder changes (build 51)", 1)
p.write_text(s)
print("mutated")
