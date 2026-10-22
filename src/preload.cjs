const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('desktop',{call:(name,value)=>ipcRenderer.invoke('command',name,value),onState:fn=>{ipcRenderer.on('state',(_,v)=>fn(v))}});
