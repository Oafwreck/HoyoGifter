/* Direct Discord requests only. Persisted coordination contains no webhook token. */
(() => {
  'use strict';
  const S=globalThis.HoyoSafety,L=S.LIMITS;
  const RATE_KEY='hoyo_delivery_limits_v1',SENT_KEY='hoyo_sent_codes_v1',LEASE_KEY='hoyo_delivery_lease_v1';
  class Delivery {
    constructor(options={}) {
      this.now=options.now||(()=>Date.now());this.fetch=options.fetch||((...args)=>fetch(...args));
      try{this.storage=options.storage||globalThis.localStorage;}catch{this.storage={getItem(){throw Error();},setItem(){throw Error();},removeItem(){throw Error();}};}
      this.locks=options.locks===undefined?globalThis.navigator?.locks:options.locks;
      this.persist=options.persist||(()=>true);this.onStorageError=options.onStorageError||(()=>{});
      this.sleep=options.sleep||(ms=>new Promise(r=>setTimeout(r,ms)));this.busy=false;this.used=new WeakSet();
      this.rate={normal:0,global:0,tests:{},routes:{},dead:{}};this.sent=[];
      this.owner=globalThis.crypto?.randomUUID?.()||`${Date.now()}-${Math.random()}`;
    }
    read(key,max=L.storageChars){try{const text=this.storage.getItem(key);if(!text)return null;if(text.length>max)throw Error();return JSON.parse(text);}catch{return null;}}
    write(key,value){try{this.storage.setItem(key,JSON.stringify(value));return true;}catch{this.onStorageError();return false;}}
    syncRate(){
      const data=this.read(RATE_KEY,20000),valid=n=>Number.isFinite(n)&&n>=0;
      if(data&&typeof data==='object'){
        for(const k of ['normal','global'])if(valid(data[k]))this.rate[k]=Math.max(this.rate[k],data[k]);
        for(const k of ['tests','routes','dead'])if(data[k]&&typeof data[k]==='object')for(const [id,n] of Object.entries(data[k]).slice(0,100))if(/^[0-9]{5,25}$/.test(id)&&valid(n))this.rate[k][id]=Math.max(this.rate[k][id]||0,n);
      }
      return this.rate;
    }
    saveRate(){
      for(const k of ['tests','routes','dead'])this.rate[k]=Object.fromEntries(Object.entries(this.rate[k]).filter(([,n])=>n>this.now()).slice(-100));
      this.write(RATE_KEY,this.rate);
    }
    remaining(kind,keys=[]){
      const r=this.syncRate();return Math.max(0,r.global,(kind==='test'?0:r.normal),...keys.map(id=>Math.max(r.routes[id]||0,r.dead[id]||0,kind==='test'?r.tests[id]||0:0)))-this.now()>0
        ? Math.max(0,r.global,(kind==='test'?0:r.normal),...keys.map(id=>Math.max(r.routes[id]||0,r.dead[id]||0,kind==='test'?r.tests[id]||0:0)))-this.now():0;
    }
    loadSent(){
      const data=this.persist()?this.read(SENT_KEY):null;
      const rows=[...this.sent,...(Array.isArray(data)&&data.length<=L.sentRecords?data:[])];
      const unique=new Map();
      for(const r of rows)if(r&&typeof r.game==='string'&&Object.hasOwn(S.GAMES,r.game)&&typeof r.code==='string'&&!S.codeReason(r.code,r.game)&&/^[0-9]{5,25}$/.test(r.webhook)&&Number.isFinite(r.at)&&r.at<=this.now()+1000&&r.at>this.now()-L.sentRetentionMs){const key=`${r.game}:${r.webhook}:${r.code}`;if(!unique.has(key)||unique.get(key).at<r.at)unique.set(key,{game:r.game,code:r.code,webhook:r.webhook,at:r.at});}
      this.sent=[...unique.values()].sort((a,b)=>a.at-b.at).slice(-L.sentRecords);return this.sent;
    }
    repeats(items){const sent=this.loadSent();return sent.filter(r=>items.some(item=>item.game===r.game&&S.webhookUrl(item.target.url).key===r.webhook&&item.codes.includes(r.code)));}
    record(item){
      if(!item.codes.length)return;this.loadSent();const key=S.webhookUrl(item.target.url).key;
      for(const code of item.codes)this.sent.push({game:item.game,code,webhook:key,at:this.now()});
      this.loadSent();if(this.persist())this.write(SENT_KEY,this.sent);
    }
    forgetSent(){this.sent=[];try{this.storage.removeItem(SENT_KEY);}catch{this.onStorageError();}}
    resetTarget(url){const key=S.webhookUrl(url).key;this.syncRate();delete this.rate.dead[key];this.saveRate();}
    async withLock(callback){
      if(this.locks?.request)return this.locks.request('hoyo-discord-send-v1',{ifAvailable:true},lock=>{if(!lock)throw Error('別のタブで送信中です。完了後にお試しください。');return callback();});
      const now=this.now(),lease=this.read(LEASE_KEY,1000);
      if(lease?.expires>now)throw Error('別のタブで送信中です。完了後にお試しください。');
      const value={owner:this.owner,expires:now+30000};if(!this.write(LEASE_KEY,value))throw Error('複数タブの送信確認ができません。ブラウザの保存設定を確認してください。');
      await this.sleep(60);if(this.read(LEASE_KEY,1000)?.owner!==this.owner)throw Error('別のタブの送信を優先しました。後でお試しください。');
      const heartbeat=setInterval(()=>{if(this.read(LEASE_KEY,1000)?.owner===this.owner)this.write(LEASE_KEY,{owner:this.owner,expires:this.now()+30000});},5000);
      try{return await callback();}finally{clearInterval(heartbeat);if(this.read(LEASE_KEY,1000)?.owner===this.owner)try{this.storage.removeItem(LEASE_KEY);}catch{}}
    }
    validatePlan(plan){
      if(!plan||!['normal','retry','test'].includes(plan.kind)||!Array.isArray(plan.items)||!plan.items.length||plan.items.length>L.messages)throw Error('1回の操作は合計10投稿までです。送信先やコードを減らしてください。');
      const keys=new Set(),codes=new Set(),games=new Set(),posts=new Set();
      for(const item of plan.items){const u=S.webhookUrl(item.target.url);S.name(item.target.name);keys.add(u.key);
        if(typeof item.content!=='string'||!item.content||item.content.length>L.messageChars)throw Error('投稿は2,000文字以内にしてください。');
        if(plan.kind!=='test'){
          const expected=S.lines(item.codes,item.game,item.prefix).map(r=>r.content).join('\n');if(item.content!==expected)throw Error('送信内容を作り直してください。');
          if(item.target.game!==item.game || !item.target.enabled)throw Error('送信先の対応ゲームと有効設定を確認してください。');
          games.add(item.game);for(const code of item.codes){const pair=u.key+':'+code;if(posts.has(pair))throw Error('同じ操作内に重複した投稿があります。');posts.add(pair);codes.add(code);}
        }else if(plan.items.length!==1||item.content!=='HoyoGift Hub 接続確認'||item.codes.length)throw Error('テスト送信の内容が正しくありません。');
      }
      if(keys.size>(plan.kind==='test'?1:L.targets))throw Error('送信先は1回5件までです。有効な送信先を減らしてください。');
      if(codes.size>L.codes||games.size>1)throw Error('1回の操作は1ゲーム・20コードまでです。');
      return [...keys];
    }
    async request(item){
      const u=S.webhookUrl(item.target.url);const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),L.timeoutMs);
      try{
        const response=await this.fetch(u.url+'?wait=true',{method:'POST',mode:'cors',credentials:'omit',redirect:'error',referrerPolicy:'no-referrer',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:item.content,allowed_mentions:{parse:[]}}),signal:controller.signal});
        const header=name=>response.headers?.get(name);
        if(response.status===429){
          let data={};try{data=await response.json();}catch{}
          const seconds=raw=>{if(raw===null||raw===undefined||raw==='')return 0;const n=Number(raw);return Number.isFinite(n)&&n>=0?n:0;};
          const retry=header('Retry-After');const dateRetry=retry&&!Number.isFinite(Number(retry))?Math.max(0,Date.parse(retry)-this.now())/1000:0;
          const delay=Math.max(seconds(retry),dateRetry,seconds(header('X-RateLimit-Reset-After')),seconds(data.retry_after),1)*1000;
          const until=this.now()+Math.ceil(delay);this.rate.routes[u.key]=until;
          if(data.global===true||header('X-RateLimit-Global')==='true'||header('X-RateLimit-Scope')==='global'||typeof data.global!=='boolean')this.rate.global=until;
          this.saveRate();return {ok:false,retry:true,message:`Discordの制限により停止。${Math.ceil(delay/1000)}秒後から手動で再送できます。`};
        }
        if(['401','403','404'].includes(String(response.status))){this.rate.dead[u.key]=this.now()+365*86400000;this.saveRate();return {ok:false,retry:false,dead:true,message:`送信先を停止（HTTP ${response.status}）。DiscordでURL・権限を確認し、URLを再設定してください。`};}
        if(!response.ok)return {ok:false,retry:response.status>=500,message:`送信失敗（HTTP ${response.status}）。設定や内容を確認してください。`};
        if(header('X-RateLimit-Remaining')==='0'){
          const reset=Number(header('X-RateLimit-Reset-After'));const unix=Number(header('X-RateLimit-Reset'))*1000;
          this.rate.routes[u.key]=Math.max(this.now()+1000,Number.isFinite(reset)&&reset>0?this.now()+reset*1000:0,Number.isFinite(unix)?unix:0);this.saveRate();
        }
        return {ok:true,message:'送信成功'};
      }catch(error){return {ok:false,retry:true,uncertain:true,message:error.name==='AbortError'?'応答待ちが8秒を超えました。届いているかチャンネルを確認してください。':'通信・CORSエラー。届いているかチャンネルを確認してください。'};}
      finally{clearTimeout(timeout);}
    }
    async run(plan,onResult=()=>{},onProgress=()=>{}){
      if(this.busy||this.used.has(plan))throw Error('この操作はすでに実行中、または実行済みです。');
      const keys=this.validatePlan(plan);this.busy=true;
      try{return await this.withLock(async()=>{
        const left=this.remaining(plan.kind,keys);if(left>0)throw Error(`あと${Math.ceil(left/1000)}秒お待ちください。`);
        if(plan.kind!=='test'&&this.repeats(plan.items).some(r=>r.at>plan.reviewedAt))throw Error('確認後に別のタブで同じコードが送信されました。送信内容を確認し直してください。');
        this.used.add(plan);const started=this.now();
        if(plan.kind==='test')this.rate.tests[keys[0]]=started+L.testCooldownMs;else this.rate.normal=started+L.cooldownMs;this.saveRate();
        const failed=[],stopped=new Map();let ok=0,done=0;
        try{for(const item of plan.items){
          const key=S.webhookUrl(item.target.url).key;
          let result;
          if(stopped.has(key))result={ok:false,retry:stopped.get(key),message:'同じ送信先の残りの投稿を停止しました。'};
          else if(this.remaining('test',[key])>0 && (this.rate.global>this.now()||this.rate.routes[key]>this.now()||this.rate.dead[key]>this.now()))result={ok:false,retry:true,message:'Discordの待機時間中のため未送信です。'};
          else result=await this.request(item);
          if(result.ok){ok++;this.record(item);}else {stopped.set(key,result.retry);if(result.retry)failed.push(item);}
          onResult(item,result);onProgress(++done,plan.items.length);
          if(done<plan.items.length)await this.sleep(L.requestGapMs);
        }}finally{
          if(plan.kind==='test')this.rate.tests[keys[0]]=Math.max(this.rate.tests[keys[0]]||0,this.now()+L.testCooldownMs);
          else this.rate.normal=Math.max(this.rate.normal,this.now()+L.cooldownMs);this.saveRate();
        }
        return {ok,total:plan.items.length,failed,state:ok===plan.items.length?'success':ok?'partial':'error'};
      });}finally{this.busy=false;}
    }
  }
  globalThis.HoyoDelivery={Delivery,RATE_KEY,SENT_KEY,LEASE_KEY};if(typeof module!=='undefined')module.exports=globalThis.HoyoDelivery;
})();
