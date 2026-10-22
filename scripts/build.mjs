import {packager} from '@electron/packager';
import {mkdir,copyFile} from 'node:fs/promises';
import {join} from 'node:path';
const result=await packager({dir:'.',name:'Automated-Pages-Generator',platform:'win32',arch:'x64',out:'build',overwrite:true,electronZipDir:process.env.ELECTRON_ZIP_DIR||undefined,ignore:[/^\/(build|test|scripts|docs|node_modules|\.git|\.github)(\/|$)/]});
console.log(result.join('\n'));
for(const dir of result){await mkdir(join(dir,'docs'),{recursive:true});await copyFile('README.md',join(dir,'README.md'));for(const name of ['manual-test.md','verification.md'])await copyFile('docs/'+name,join(dir,'docs',name))}
