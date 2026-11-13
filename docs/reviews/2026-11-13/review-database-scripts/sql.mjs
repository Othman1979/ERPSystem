import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire('D:/ERPSYSTEM/apps/api/package.json');
const mariadb = require('mariadb');
const env = fs.readFileSync('D:/ERPSYSTEM/apps/api/.env','utf8');
const m = env.match(/^DATABASE_URL\s*=\s*"?([^"\r\n]+)"?/m);
const u = new URL(m[1]);
const db = process.env.DB || u.pathname.slice(1);
const conn = await mariadb.createConnection({host:u.hostname,port:+u.port||3306,user:decodeURIComponent(u.username),password:decodeURIComponent(u.password),database:db,bigIntAsNumber:true,decimalAsNumber:false,multipleStatements:true});
const sql = process.argv[2] === '-f' ? fs.readFileSync(process.argv[3],'utf8') : process.argv.slice(2).join(' ');
try {
  const r = await conn.query(sql);
  const out = (x)=>{ if (Array.isArray(x)) { if (x.length && Array.isArray(x[0])) x.forEach(out); else x.forEach(o=>console.log(Object.values(o).map(v=>v===null?"NULL":String(v)).join("	"))); } else console.log(x); };
  out(r);
} catch(e){ console.error('ERR', e.message); }
await conn.end();
