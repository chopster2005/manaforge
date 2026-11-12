import fs from 'node:fs';
import path from 'node:path';
fs.mkdirSync('dist',{recursive:true});
for (const f of ['index.html']) fs.copyFileSync(f,path.join('dist',f));
for (const f of ['manifest.webmanifest','sw.js']) fs.copyFileSync(path.join('public',f),path.join('dist',f));
fs.copyFileSync(path.join('src','styles.css'),path.join('dist','styles.css'));
