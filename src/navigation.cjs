const DOUBAO_URL='https://www.doubao.com/chat/';
class Navigation {
 constructor(contents,update,timeout=20000){this.contents=contents;this.update=update;this.timeout=timeout;this.attempt=0}
 open(){const attempt=++this.attempt;clearTimeout(this.timer);this.contents.stop();this.update({browserStatus:'loading',browserError:'正在连接豆包，请在右侧等待页面；20 秒未连接会显示错误。'});
 const finish=(status,error='')=>{if(attempt!==this.attempt)return;clearTimeout(this.timer);this.attempt++;this.update({browserStatus:status,browserError:error})};
 this.timer=setTimeout(()=>{finish('failed','连接豆包超时。请确认本机网络可访问 www.doubao.com，再点击重新打开豆包。');this.contents.stop()},this.timeout);
 Promise.resolve().then(()=>this.contents.loadURL(DOUBAO_URL)).then(()=>finish('ready','豆包页面已加载。登录状态请以右侧页面为准。'),error=>finish('failed','打开豆包失败：'+error.message+'。请检查网络后重试。'));
 return {status:'loading'};
 }
}
module.exports={Navigation,DOUBAO_URL};
