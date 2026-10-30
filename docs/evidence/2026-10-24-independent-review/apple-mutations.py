from pathlib import Path
import sys
r=Path(sys.argv[1])
def edit(file,old,new):
 p=r/file;s=p.read_text();assert old in s,file;p.write_text(s.replace(old,new))
p=r/'PigTV/PrivateCaches.swift';s=p.read_text();a=s.index('        guard let accountID else { return nil }',s.index('static func localResumeKey'));b=s.index('\n    }',a);s=s[:a]+'        return "pigtv.resume.\\(id)"'+s[b:];p.write_text(s)
# Restore uncounted writes while retaining the new API to keep regression tests compilable.
edit('PigTV/PrivateCaches.swift','if budget.add(data.count - previous, limit: limit) {','if false {')
# A2: remove both publication gates, as required to reproduce old behavior with the new API.
edit('PigTV/TopShelfExport.swift','if let generation, generation != self.current { continuation.resume(returning: nil); return }','// mutation: accept retired generations')
edit('PigTV/TopShelfExport.swift','guard generation == TopShelfPublication.shared.current else { return }','// mutation: accept retired saves')
# A3: old setRule body, retaining Bool result required by new tests.
p=r/'PigTV/BrowseModel.swift';s=p.read_text();a=s.index('        guard !mutationBusy else { return false }',s.index('func setRule'));b=s.index('\n        do {',a);s=s[:a]+s[b:];p.write_text(s)
# A4: old same-shape branch never refreshes the visible cells.
edit('PigTV/GuideGridView.swift','            refresh(corrected)\n','            // mutation: no refresh for same-shape correction\n')
print('Applied isolated behavioral mutations A1, A2, A3, A4, A5 to', r)
