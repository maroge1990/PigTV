// Run in the PigTV container: docker exec -i PigTV node - < export.js > prod-sports.json.gz
// Explicitly read-only SQLite; exports only what the Sports build reads for VISIBLE channels (names, guide ids,
// mappings, guide rows 26-30 Oct, follow list, fixtures, rosters). Never stream_url: tvgId is derived from data in place.

const D=require('/app/node_modules/better-sqlite3');const d=new D('/app/data/content.db',{readonly:true,fileMustExist:true});
const zlib=require('zlib');
const LISTED=`p.type='live' AND p.is_hidden=0 AND NOT EXISTS (SELECT 1 FROM categories c WHERE c.source_id=p.source_id AND c.type=p.type AND c.category_id=p.category_id AND c.is_hidden=1)`;
const SIB=`EXISTS (SELECT 1 FROM channel_links l WHERE l.backup_source_id=p.source_id AND l.primary_source_id=p.source_id AND l.backup_stream_id=COALESCE(p.stable_id,p.item_id) AND l.method='sibling' AND l.status IN ('auto','approved','manual'))`;
const ch=d.prepare(`SELECT p.source_id,p.item_id,p.stable_id,p.name,p.category_id,p.sort_order,p.tvg_id,p.data FROM playlist_items p WHERE ${LISTED} AND NOT ${SIB}`).all().map(r=>{let t=r.tvg_id; if(!t){try{const j=JSON.parse(r.data||'{}');t=j.tvgId||j.epg_channel_id||null}catch{t=null}} return {source_id:r.source_id,item_id:r.item_id,stable_id:r.stable_id,name:r.name,category_id:r.category_id,sort_order:r.sort_order,tvg_id:t};});
const keys=new Set(ch.map(r=>r.stable_id||r.item_id));
const maps=d.prepare("SELECT source_id,channel_key,tvg_id FROM epg_mappings").all().filter(m=>keys.has(m.channel_key));
const tvgs=[...new Set([...ch.map(r=>r.tvg_id),...maps.map(m=>m.tvg_id)].filter(Boolean))];
const from=Date.parse('2026-10-26T01:00Z'), to=Date.parse('2026-10-30T21:30Z');
const progs=[]; for(let i=0;i<tvgs.length;i+=500){const c=tvgs.slice(i,i+500); progs.push(...d.prepare(`SELECT channel_id,source_id,start_time,end_time,title,categories,flags FROM epg_live WHERE channel_id IN (${c.map(()=>'?').join(',')}) AND start_time>=? AND start_time<?`).all(...c,from,to));}
const out={exportedAt:new Date().toISOString(), channels:ch, mappings:maps, programmes:progs,
 follow:d.prepare("SELECT position,keyword FROM sports_follow").all(),
 sportCategories:d.prepare("SELECT source_id,category_id FROM sport_categories").all(),
 fixtures:d.prepare("SELECT * FROM sport_fixtures").all(), teams:d.prepare("SELECT * FROM sport_fixture_teams").all(), status:d.prepare("SELECT * FROM sport_fixture_status").all()};
process.stdout.write(zlib.gzipSync(JSON.stringify(out)));
