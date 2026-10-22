"""Create a complete portable distribution, excluding all per-user data."""
from pathlib import Path
import zipfile,hashlib,json
root=Path(__file__).resolve().parents[1]
version=json.loads((root/'package.json').read_text(encoding='utf8'))['version']
source=root/'build'/version/'Automated-Pages-Generator-win32-x64'
archive=root/f'build/Automated-Pages-Generator-{version}-win32-x64-experimental.zip'
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
    for path in source.rglob('*'):
        if path.is_file():z.write(path,path.relative_to(source.parent))
digest=hashlib.sha256(archive.read_bytes()).hexdigest()
(root/'build/SHA256SUMS.txt').write_text(digest+'  '+archive.name+'\n',encoding='utf8')
print(archive.name,archive.stat().st_size,digest)
