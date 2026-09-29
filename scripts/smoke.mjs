import {spawnSync} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
const commands=[['--help'],['doctor','--json'],['inspect','--json'],['devices','--json'],['emulator','list','--json'],['build','--json'],['test','--json']];
const rows=commands.map(args=>{const r=spawnSync(process.execPath,['dist/cli/index.js',...args],{encoding:'utf8',timeout:120000});let body;try{body=JSON.parse(r.stdout);}catch{body=null;}return {command:'android-agent '+args.join(' '),exitCode:r.status,error:r.error?.message??body?.error?.code??null,ready:body?.result?.ready??null,checks:body?.result?.checks?.map(c=>({name:c.name,status:c.status})),stdoutPresent:r.stdout.length>0};});
await writeFile('docs/smoke-results.json',JSON.stringify({at:new Date().toISOString(),node:process.version,platform:process.platform,results:rows},null,2)+'\n');console.log(JSON.stringify(rows,null,2));
if(rows[0].exitCode!==0||rows[2].exitCode!==0)process.exitCode=1;
