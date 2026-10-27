import csv,sys
def load(f,tbs):
    s={0:[],1:[]}
    for r in csv.reader(open(f)):
        if len(r)<4 or r[1]=='N/A': continue
        i=int(r[0]); pts=int(r[1]) if r[1]!='N/A' else None; dts=int(r[2]) if r[2]!='N/A' else None; d=int(r[3]) if r[3] not in('N/A','') else 0
        tb=tbs[i]; s[i].append((pts*tb, dts*tb if dts is not None else None, d*tb))
    return s
src=load('src.csv',{0:1/90000,1:1/90000}); out=load('out.csv',{0:1/60000,1:1/48000})
for name,s in (('src',src),('out',out)):
    v=s[0]; a=sorted(s[1])
    gaps=[(a[k][0], a[k+1][0]-(a[k][0]+a[k][2])) for k in range(len(a)-1)]
    big=[g for g in gaps if abs(g[1])>0.002]
    print(f"{name}: video {len(v)} pkts {v[0][0]:.3f}..{max(p[0] for p in v):.3f}; audio {len(a)} pkts {a[0][0]:.3f}..{a[-1][0]+a[-1][2]:.3f}; audio sum of durations {sum(p[2] for p in a):.3f}s; audio gaps/overlaps >2ms: {len(big)} total {sum(g[1] for g in big):+.3f}s")
    for g in big[:8]: print('   at %.3f gap %+.4f'%g)
# video mapping by index (copy): offset per packet
sv=src[0]; ov=out[0]
n=min(len(sv),len(ov)); off=[ov[i][0]-sv[i][0] for i in range(n)]
base=sorted(off)[n//2]
dev=[(i,off[i]-base) for i in range(n) if abs(off[i]-base)>0.001]
print(f"video: {len(sv)} src vs {len(ov)} out; offset out-src median {base:.4f}; packets whose pts moved >1ms: {len(dev)}", [ (round(ov[i][0],3), round(d,4)) for i,d in dev[:10]])
# audio: compare start/end alignment relative to video
sa=sorted(src[1]); oa=sorted(out[1])
print("audio start minus video start: src %+.4f out %+.4f"%(sa[0][0]-min(p[0] for p in sv), oa[0][0]-min(p[0] for p in ov)))
print("audio end minus video end:     src %+.4f out %+.4f"%(sa[-1][0]+sa[-1][2]-max(p[0] for p in sv), oa[-1][0]+oa[-1][2]-max(p[0] for p in ov)))
# drift over time: out audio pts vs src audio time mapped by video offset
import bisect
st=[p[0] for p in sa]
print("audio offset (out - src - video offset) sampled every ~100 s:")
for k in range(0,len(oa),len(oa)//9):
    t=oa[k][0]-base
    j=bisect.bisect_left(st,t)
    # nearest src audio frame start; report residual modulo frame (only meaningful if contiguous)
    print("  out t=%.1f -> src nearest residual %+.4f"%(oa[k][0], st[min(j,len(st)-1)]-t))
