"""Publish a new immutable-version portable package using local Git credentials.

Credentials remain in memory and are never printed or written to disk.
Existing releases are not modified by this script.
"""
import json, subprocess, urllib.request, urllib.error, hashlib, tempfile, os
from pathlib import Path
root=Path(__file__).resolve().parents[1]
repo='1644ye/Automated-Pages-Generator'
version=json.loads((root/'package.json').read_text(encoding='utf8'))['version']
tag='v'+version
package=root/f'build/Automated-Pages-Generator-{version}-win32-x64-experimental.zip'
checksum=root/'build/SHA256SUMS.txt'
assert hashlib.sha256(package.read_bytes()).hexdigest() in checksum.read_text()
credentials=subprocess.run(['git','-c','credential.interactive=never','credential','fill'],input='protocol=https\nhost=github.com\n\n',text=True,capture_output=True,check=True)
token=dict(line.split('=',1) for line in credentials.stdout.splitlines() if '=' in line).get('password')
if not token: raise SystemExit('No local GitHub credential available')
def request(url,method='GET',value=None,binary=False):
    data=value if binary else json.dumps(value).encode() if value is not None else None
    # Windows system curl uses the OS TLS stack. Auth is supplied on stdin only.
    args=['curl.exe','--silent','--show-error','--max-time','180','--request',method,'--url',url,'--write-out','\n%{http_code}','--config','-']
    config='header = "Authorization: Bearer '+token+'"\nheader = "Accept: application/vnd.github+json"\nheader = "Content-Type: '+('application/octet-stream' if binary else 'application/json')+'"\n'
    path=None
    try:
        if data is not None:
            with tempfile.NamedTemporaryFile(delete=False) as f:f.write(data);path=f.name
            args+=['--data-binary','@'+path]
        result=subprocess.run(args,input=config,text=True,encoding="utf-8",capture_output=True)
        if result.returncode:raise SystemExit('Release network operation failed; curl exit '+str(result.returncode))
        body,status=result.stdout.rsplit('\n',1)
        if int(status)>=400:raise urllib.error.HTTPError(url,int(status),'GitHub API error',None,None)
        return json.loads(body)
    finally:
        if path:os.unlink(path)

api='https://api.github.com/repos/'+repo
release=None
try:
    release=request(api+'/releases/tags/'+tag)
    if not release.get('draft'):raise SystemExit('Published release already exists; no changes made')
except urllib.error.HTTPError as e:
    if e.code!=404:raise SystemExit('Release inspection failed: HTTP '+str(e.code))
if release is None:
    release=next((r for r in request(api+'/releases?per_page=100') if r['tag_name']==tag),None)
    if release and not release.get('draft'):raise SystemExit('Published release already exists; no changes made')
head=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()
notes=(root/'docs/release-0.3.6.md').read_text(encoding='utf8')
try:
    release=release or request(api+'/releases','POST',{'tag_name':tag,'target_commitish':head,'name':'Automated Pages Generator '+tag,'body':notes,'draft':True,'prerelease':False})
    for file in [package,checksum,root/'docs/release-0.3.6.md']:
        prior=next((a for a in release.get('assets',[]) if a['name']==file.name),None)
        if prior:
            assert prior.get('digest')=='sha256:'+hashlib.sha256(file.read_bytes()).hexdigest()
            continue
        asset=request(release['upload_url'].split('{')[0]+'?name='+file.name,'POST',file.read_bytes(),True)
        assert asset['size']==file.stat().st_size
        if file==package:assert asset.get('digest')=='sha256:'+hashlib.sha256(file.read_bytes()).hexdigest()
        print('Uploaded:',file.name,flush=True)
    final=request(api+'/releases/'+str(release['id']),'PATCH',{'draft':False})
    print('Published:',final['html_url'])
except urllib.error.HTTPError as e:
    raise SystemExit('Publish failed: HTTP '+str(e.code)+'; any draft is preserved for inspection')
