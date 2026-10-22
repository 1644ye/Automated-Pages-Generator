'use strict';
const menuHeaders=['ID','Handle','Command','Title','Is Default','Top Row','Row #','Menu Item: ID','Menu Item: Title','Menu Item: Command','Menu Item: Resource Type','Menu Item: Resource ID','Menu Item: Resource Handle','Menu Item: Collection Tags','Menu Item: URL','Menu Item: Parent ID','Menu Item: Parent Title','Menu Item: Position'];
const menuGroups=[{handle:'about',title:'About',pages:['contact-us','about-us']},{handle:'information',title:'Information',pages:['customer-service-policy','privacy-policy','refund-policy','shipping-policy','terms-of-purchase','terms-of-use']}];
function menuRows(){
  const result=[menuHeaders];let row=0;
  for(const group of menuGroups){
    group.pages.forEach((handle,index)=>{
      const page=data.pages.find(p=>p.handle===handle);
      if(!page)throw Error(`缺少菜单关联页面：${handle}`);
      result.push(['',group.handle,'MERGE',group.title,false,index===0?true:'',++row,'',page.title,'MERGE','PAGE','',page.handle,'',`/pages/${page.handle}`,'','',index+1]);
    });
  }
  return result;
}
function columnName(index){let out='';for(let n=index+1;n>0;n=Math.floor((n-1)/26))out=String.fromCharCode(65+(n-1)%26)+out;return out}
function sheetXml(matrix){
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" state="frozen"/></sheetView></sheetViews><sheetData>'+matrix.map((row,r)=>`<row r="${r+1}">`+row.map((v,c)=>{
    const ref=columnName(c)+(r+1);
    if(typeof v==='boolean')return `<c r="${ref}" t="b"><v>${v?1:0}</v></c>`;
    if(typeof v==='number')return `<c r="${ref}"><v>${v}</v></c>`;
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(v??'')}</t></is></c>`;
  }).join('')+'</row>').join('')+'</sheetData></worksheet>';
}
// Pages comes first so the workbook introduces the resources before their menu links.
function workbook(matrix,menus=menuRows()){
  const enc=new TextEncoder(),sheets=[{name:'Pages',rows:matrix},{name:'Menus',rows:menus}];
  const files={
    '[Content_Types].xml':'<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'+sheets.map((_,i)=>`<Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')+'</Types>',
    '_rels/.rels':'<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml':'<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'+sheets.map((s,i)=>`<sheet name="${s.name}" sheetId="${i+1}" r:id="rId${i+1}"/>`).join('')+'</sheets></workbook>',
    'xl/_rels/workbook.xml.rels':'<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+sheets.map((_,i)=>`<Relationship Id="rId${i+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i+1}.xml"/>`).join('')+'</Relationships>'
  };
  sheets.forEach((sheet,i)=>files[`xl/worksheets/sheet${i+1}.xml`]=sheetXml(sheet.rows));
  return zip(Object.entries(files).map(([name,text])=>[enc.encode(name),enc.encode(text)]));
}
