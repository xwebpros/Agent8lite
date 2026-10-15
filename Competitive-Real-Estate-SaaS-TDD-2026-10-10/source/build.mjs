import fs from 'node:fs/promises';
import path from 'node:path';
import {out} from './contracts.mjs';
import {buildDocument} from './document.mjs';
import {validateArtifacts,buildManifest} from './validate.mjs';
let audit;
try{audit=JSON.parse(await fs.readFile(path.join(out,'reference/source-audit.json'),'utf8'));}
catch(error){if(error.code!=='ENOENT')throw error;audit=JSON.parse(await fs.readFile(path.join(out,'../reports/agent-elite-audit-2026-10-10.json'),'utf8'));}
const built=await buildDocument(audit);
const validation=await validateArtifacts();
await buildManifest();
console.log(JSON.stringify({built,validation},null,2));
