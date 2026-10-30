from pathlib import Path
import subprocess,tempfile,shutil,os,sys
root=Path(__file__).resolve().parents[3];out=Path(__file__).resolve().parent
node='/opt/homebrew/opt/node@24/bin/node'
def run(label,server='HEAD',test='sports-fixtures.test.js',testref='HEAD',pattern='R4-S1',transform=None,mutation=False):
 if len(sys.argv)>1 and label not in sys.argv[1:]: return
 with tempfile.TemporaryDirectory(prefix='pigtv-r5-proof-') as t:
  p=Path(t); (p/'test').mkdir()
  archive=subprocess.check_output(['git','archive',server,'server'],cwd=root)
  subprocess.run(['tar','-x','-C',t],input=archive,check=True)
  for item in ['helpers','fixtures']:shutil.copytree(root/'test'/item,p/'test'/item)
  shutil.copy(root/'package.json',p/'package.json');(p/'node_modules').symlink_to(root/'node_modules')
  code=subprocess.check_output(['git','show',testref+':test/'+test],cwd=root).decode()
  if transform:code=transform(code)
  if mutation:code=code.replace("    assert.equal(count(), 3, 'both refusals were retried');", "    await transcodeSession.removeSession(s.id); // review harness: cleanup even when the intended assertion fails\n    assert.equal(count(), 3, 'both refusals were retried');")
  (p/'test'/test).write_text(code)
  if mutation:
   f=p/'server/services/transcodeSession.js';s=f.read_text();old='this.retryAllowanceMs = (this.retryAllowanceMs || 0) + sinceSpawn + delay;';assert old in s;f.write_text(s.replace(old,'this.retryAllowanceMs = 0; // review mutation'))
  try:r=subprocess.run([node,'--test','--test-timeout=25000','--test-name-pattern='+pattern,'test/'+test],cwd=p,env={**os.environ,'PIGTV_SKIP_PERF':'1'},stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=35)
  except subprocess.TimeoutExpired as e:
   (out/(label+'.log')).write_bytes(e.stdout or b'');print(label,'TIMEOUT',flush=True);return
  (out/(label+'.log')).write_bytes(r.stdout);print(label,r.returncode,r.stdout.decode()[-700:],flush=True)
run('cricket-parent',server='d0ace59^')
run('cricket-current')
shift=lambda s:s.replace('const NOW = Date.now();','const NOW = Date.now() - 5 * 60 * 1000;')
run('clock-parent',test='sports-worker.test.js',testref='4e6cb33^',pattern='a stale cache',transform=shift)
run('clock-current',test='sports-worker.test.js',pattern='a stale cache',transform=shift)
run('retry-current',test='start-failure.test.js',pattern='timeout is extended')
run('retry-no-allowance',test='start-failure.test.js',pattern='timeout is extended',mutation=True)

extra = r"""
test('ROUND5: empty league lists are valid, nested null and mixed malformed leagues preserve coverage', async () => {
 const at=Date.parse('2026-09-27T12:00Z');
 for(const body of [{scores:[null]}, {scores:[{leagues:[null]}]}, {scores:[{leagues:[{id:'22547'},{}]}]}, {scores:[{leagues:[]},{leagues:[{}]}]}]) {
  await withEspn(cricketHandlers(),()=>fixtures.refreshCricket({now:at}));
  await withEspn({...cricketHandlers(),scorepanel:body},()=>fixtures.refreshCricket({now:at+1000}));
  const cricket=fixtures.snapshot(new Set(['Cricket'])).get('Cricket');
  assert.equal(cricket.fixtures.length,1);assert.equal(cricket.coverage.at,at);
 }
 await withEspn({...cricketHandlers(),scorepanel:{scores:[{leagues:[]}]}},()=>fixtures.refreshCricket({now:at+1000}));
 const empty=fixtures.snapshot(new Set(['Cricket'])).get('Cricket');
 assert.equal(empty.fixtures.length,0);assert.equal(empty.coverage.at,at+1000);
});
"""
run('cricket-boundaries',pattern='ROUND5',transform=lambda s:s+extra)
