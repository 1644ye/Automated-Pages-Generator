// Apply only the latest URL task, once. Later state polls preserve manual edits.
function nextSeoFill(tasks,applied){
 const task=[...(tasks||[])].reverse().find(t=>t.urlSource);
 if(!task||applied.has(task.id)||!['已完成','待导出'].includes(task.status))return null;
 const title=task.content?.items?.find(x=>x.id==='home-title')?.text;
 const description=task.content?.items?.find(x=>x.id==='home-description')?.text;
 if(typeof title!=='string'||!title.trim()||typeof description!=='string'||!description.trim())return null;
 return {id:task.id,title,description,url:task.urlSource.url};
}
if(typeof module!=='undefined')module.exports={nextSeoFill};
