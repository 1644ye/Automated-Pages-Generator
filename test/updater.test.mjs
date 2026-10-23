import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
const {Updater,newer,releaseInfo}=createRequire(import.meta.url)('../src/updater.cjs');
const data=Buffer.from('synthetic archive');
const release={tag_name:'v0.3.7',assets:[{name:'Automated-Pages-Generator-0.3.7-win32-x64-experimental.zip',state:'uploaded',size:data.length,digest:'sha256:'+createHash('sha256').update(data).digest('hex'),browser_download_url:'https://github.com/1644ye/Automated-Pages-Generator/releases/download/v0.3.7/Automated-Pages-Generator-0.3.7-win32-x64-experimental.zip'}]};
test('update selection rejects old, prerelease, missing checksum and foreign URLs',()=>{
 assert.ok(newer('0.10.0','0.9.9'));assert.equal(newer('0.3.6','0.3.6'),false);assert.equal(newer('0.4.0-beta','0.3.6'),false);
 assert.equal(releaseInfo({...release,prerelease:true},'0.3.6'),null);
 assert.equal(releaseInfo(release,'0.3.7'),null);
 assert.throws(()=>releaseInfo({...release,assets:[{...release.assets[0],digest:null}]},'0.3.6'));
 assert.throws(()=>releaseInfo({...release,assets:[{...release.assets[0],browser_download_url:'https://other.example/a.zip'}]},'0.3.6'));
});
test('download checksum failure never extracts or marks update ready',async()=>{
 let extracted=false;const dir=await mkdtemp(join(tmpdir(),'apg-update-'));
 const u=new Updater({version:'0.3.6',dir,fetcher:async url=>url.includes('api.github')?Response.json(release):new Response(Buffer.alloc(data.length)),extractor:async()=>{extracted=true}});
 await u.check(true);assert.equal(u.state.phase,'error');assert.match(u.state.message,/SHA256/);assert.equal(extracted,false);
});
test('verified update stages separately without launching any application',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'apg-update-'));
 const u=new Updater({version:'0.3.6',dir,fetcher:async url=>url.includes('api.github')?Response.json(release):new Response(data),extractor:async(_zip,dest)=>{
  const root=join(dest,'Automated-Pages-Generator-win32-x64');await mkdir(join(root,'resources','app.asar'),{recursive:true});await writeFile(join(root,'resources','app.asar','package.json'),JSON.stringify({name:'automated-pages-generator',version:'0.3.7'}));await writeFile(join(root,'Automated-Pages-Generator.exe'),'synthetic');
 }});await u.check(true);assert.equal(u.state.phase,'ready');assert.ok(u.executable.startsWith(dir));
});
test('missing release and HTTP failures remain explicit',async()=>{
 for(const status of [404,403]){const u=new Updater({version:'0.3.6',dir:tmpdir(),fetcher:async()=>new Response('',{status})});await u.check(true);assert.equal(u.state.phase,status===404?'idle':'error')}
});
