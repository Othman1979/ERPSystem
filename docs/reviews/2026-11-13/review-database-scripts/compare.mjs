// Builds the before/after EXPLAIN table from two capture.mjs JSON outputs.
// usage: node compare.mjs before.md.json after.md.json out.md
import fs from 'node:fs';

const [beforeFile, afterFile, outFile] = process.argv.slice(2);
const before = JSON.parse(fs.readFileSync(beforeFile, 'utf8'));
const after = new Map(JSON.parse(fs.readFileSync(afterFile, 'utf8')).map((q) => [q.name, q]));

// The plan of a query, one cell: each EXPLAIN row as table:type/key (rows) [extra flags].
const flags = (extra) =>
  ['filesort', 'temporary', 'index condition', 'Using index'].filter((f) => extra.includes(f) && !(f === 'Using index' && extra.includes('Using index condition'))).map((f) => (f === 'Using index' ? 'covering' : f === 'index condition' ? 'ICP' : f));
const plan = (q) =>
  q.stmts
    .filter((s) => s.explain)
    .map((s) =>
      s.explain
        .map((e) => {
          const f = flags(e.extra);
          return `${e.table}: ${e.type}${e.key ? ` \`${e.key.replace(/^([a-z_]+?)_tenant_id_/, 't_')}\`` : ''} ~${e.rows}${f.length ? ` (${f.join(', ')})` : ''}`;
        })
        .join('<br>'),
    )
    .join('<br>— ');
const examined = (q) => q.stmts.filter((s) => s.explain).reduce((n, s) => n + s.explain.reduce((m, e) => m + Number(e.rows ?? 0), 0), 0);

let md = '| query | rows out | before: plan | before ms | after: plan | after ms |\n|---|---|---|---|---|---|\n';
for (const b of before) {
  const a = after.get(b.name);
  md += `| ${b.name} | ${b.rows} | ${plan(b)} | ${b.ms} | ${a ? plan(a) : '—'} | ${a ? a.ms : '—'} |\n`;
}
md += '\n`~N` is EXPLAIN\'s row estimate per step. Index names are shortened: `t_` stands for `<table>_tenant_id_`.\n';
md += '\n| query | estimated rows examined, before | after |\n|---|---|---|\n';
for (const b of before) {
  const a = after.get(b.name);
  md += `| ${b.name} | ${examined(b)} | ${a ? examined(a) : '—'} |\n`;
}
fs.writeFileSync(outFile, md);
console.log(md);
