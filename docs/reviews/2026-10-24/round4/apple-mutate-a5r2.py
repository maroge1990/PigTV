# Restores build 53's prune stop condition (repeat only after a removal) inside the build-54 code.
import sys, pathlib
p = pathlib.Path(sys.argv[1]) / 'PigTV/PrivateCaches.swift'
s = p.read_text()
old = "if (bytes ?? 0) > limit, removedAny || grew { return (true, []) }"
assert old in s
p.write_text(s.replace(old, "if (bytes ?? 0) > limit, removedAny { _ = grew; return (true, []) } // mutation: build 53", 1))
print("mutated")
