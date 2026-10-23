'use strict';
const fs=require('node:fs/promises');
const {join}=require('node:path');
const {createHash}=require('node:crypto');
const {execFile}=require('node:child_process');
const REPO='1644ye/Automated-Pages-Generator';
function newer(a,b){const parse=v=>/^\d+\.\d+\.\d+$/.test(v)?v.split('.').map(Number):null;const x=parse(a),y=parse(b);if(!x||!y)return false;for(let i=0;i<3;i++)if(x[i]!==y[i])return x[i]>y[i];return false}
function releaseInfo(release,current){
 if(release.draft||release.prerelease)return null;
 const version=String(release.tag_name||'').replace(/^v/,'');if(!newer(version,current))return null;
 const name=`Automated-Pages-Generator-${version}-win32-x64-experimental.zip`;
 const asset=release.assets?.find(a=>a.name===name&&a.state==='uploaded');
 if(!asset||!/^sha256:[a-f0-9]{64}$/.test(asset.digest||''))throw Error('新版缺少兼容安装包或 GitHub SHA256 校验信息');
 if(asset.browser_download_url!==`https://github.com/${REPO}/releases/download/${release.tag_name}/${name}`)throw Error('更新下载地址不匹配');
 if(!Number.isSafeInteger(asset.size)||asset.size<1||asset.size>500*1024*1024)throw Error('更新包大小异常');
 return {version,url:asset.browser_download_url,size:asset.size,hash:asset.digest.slice(7)};
}
function extract(zip,destination){
 // Fixed script; paths are passed as environment values, never executable text.
 const script=`$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$root=[IO.Path]::GetFullPath($env:APG_UPDATE_DEST)+[IO.Path]::DirectorySeparatorChar
$archive=[IO.Compression.ZipFile]::OpenRead($env:APG_UPDATE_ZIP)
try { $total=0; foreach($entry in $archive.Entries) {
 $target=[IO.Path]::GetFullPath([IO.Path]::Combine($root,$entry.FullName))
 if (!$target.StartsWith($root,[StringComparison]::OrdinalIgnoreCase) -or $entry.FullName.Contains(':') -or (($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) { throw 'Unsafe archive path' }
 $total+=$entry.Length; if($total -gt 2147483648){throw 'Archive too large'}
}} finally {$archive.Dispose()}
[IO.Compression.ZipFile]::ExtractToDirectory($env:APG_UPDATE_ZIP,$env:APG_UPDATE_DEST)`;
 return new Promise((resolve,reject)=>execFile('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:180000,env:{...process.env,APG_UPDATE_ZIP:zip,APG_UPDATE_DEST:destination}},error=>error?reject(Error('更新包解压失败，旧版保持不变')):resolve()));
}
class Updater{
 constructor({version,dir,onChange=()=>{},fetcher=fetch,extractor=extract}){this.version=version;this.dir=dir;this.onChange=onChange;this.fetcher=fetcher;this.extractor=extractor;this.state={phase:'idle',message:'等待检查更新'};this.busy=false}
 emit(patch){Object.assign(this.state,patch);this.onChange(this.state)}
 async check(download=false){
  if(this.busy||this.state.phase==='ready')return;this.busy=true;
  try{
   this.emit({phase:'checking',message:'正在检查 GitHub Release…',percent:null});
   const r=await this.fetcher(`https://api.github.com/repos/${REPO}/releases/latest`,{headers:{Accept:'application/vnd.github+json'},signal:AbortSignal.timeout(20000)});
   if(r.status===404){this.emit({phase:'idle',message:'尚无正式 Release，暂时没有可用更新'});return}
   if(!r.ok)throw Error('版本检查失败（HTTP '+r.status+'），可稍后重试');
   const info=releaseInfo(await r.json(),this.version);if(!info){this.emit({phase:'current',message:'当前已是最新正式版本'});return}
   this.info=info;this.emit({phase:'available',version:info.version,message:'发现新版 v'+info.version});
   if(download)await this.prepare(info);
  }catch(e){this.emit({phase:'error',message:e.message||'更新失败，当前版本不受影响'})}finally{this.busy=false}
 }
 async prepare(info){
  const base=join(this.dir,'updates');await fs.mkdir(base,{recursive:true});
  const folder=await fs.mkdtemp(join(base,info.version+'-')),zip=join(folder,'package.zip'),destination=join(folder,'app');
  this.emit({phase:'downloading',message:'正在下载 v'+info.version,percent:0});
  const r=await this.fetcher(info.url,{signal:AbortSignal.timeout(600000)});if(!r.ok||!r.body)throw Error('更新下载失败');
  const hash=createHash('sha256');let size=0;const file=await fs.open(zip,'wx');
  try{for await(const chunk of r.body){size+=chunk.length;if(size>info.size)throw Error('更新包大小不匹配');hash.update(chunk);await file.writeFile(chunk);this.emit({percent:Math.floor(size/info.size*100)})}}finally{await file.close()}
  if(size!==info.size||hash.digest('hex')!==info.hash)throw Error('更新包 SHA256 校验失败，未安装');
  this.emit({phase:'extracting',message:'校验通过，正在准备新版…',percent:null});await this.extractor(zip,destination);
  const root=join(destination,'Automated-Pages-Generator-win32-x64');
  const meta=JSON.parse(await fs.readFile(join(root,'resources','app.asar','package.json'),'utf8'));
  if(meta.name!=='automated-pages-generator'||meta.version!==info.version)throw Error('更新包内部版本不匹配');
  this.executable=join(root,'Automated-Pages-Generator.exe');await fs.access(this.executable);
  this.emit({phase:'ready',message:'v'+info.version+' 已准备好；任务结束后可重启切换。旧版仍保留。',path:this.executable});
 }
}
module.exports={Updater,newer,releaseInfo,extract};
