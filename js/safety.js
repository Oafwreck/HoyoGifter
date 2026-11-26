/* Shared bounds and validation. No network or storage side effects. */
(() => {
  'use strict';
  const LIMITS = Object.freeze({inputChars:10000,codes:20,webhooks:10,targets:5,messageChars:2000,messages:10,
    cooldownMs:30000,testCooldownMs:60000,timeoutMs:8000,requestGapMs:750,importBytes:100000,
    nameChars:80,urlChars:300,history:50,sentRecords:1000,sentRetentionMs:30*86400000,storageChars:500000,logRows:100});
  // Official pages do not publish one fixed length for all promotional codes.
  // Keep variable-length campaigns compatible; maxCodeChars is an application guard.
  const GAMES = Object.freeze({
    zzz:Object.freeze({name:'ゼンレスゾーンゼロ',short:'ゼンゼロ',base:'https://zenless.hoyoverse.com/redemption/gift?code=',minCodeChars:1,maxCodeChars:128}),
    genshin:Object.freeze({name:'原神',short:'原神',base:'https://genshin.hoyoverse.com/ja/gift?code=',minCodeChars:1,maxCodeChars:128}),
    hsr:Object.freeze({name:'崩壊：スターレイル',short:'スタレ',base:'https://hsr.hoyoverse.com/gift?code=',minCodeChars:1,maxCodeChars:128})
  });
  const gameFromBase = base => Object.keys(GAMES).find(k=>GAMES[k].base===base) || '';
  function codeReason(code,game) {
    const rule=typeof game==='string' && Object.hasOwn(GAMES,game)?GAMES[game]:null;
    if (!rule) return 'ゲームを選択してください';
    if (!/^[A-Za-z0-9]+$/.test(code)) return '半角英数字以外が含まれています';
    if (code.length<rule.minCodeChars || code.length>rule.maxCodeChars) return `${rule.minCodeChars}〜${rule.maxCodeChars}文字にしてください`;
    return '';
  }
  function codeInput(value,game) {
    let code=value.trim(),url=false;
    if(/^https?:\/\//i.test(code)) {
      const invalid={code:'',url:false,reason:'対象ゲームの公式交換URLを使用してください'};
      let u;try{u=new URL(code);}catch{return invalid;}
      if(u.protocol!=='https:'||u.username||u.password||u.port||u.hash)return invalid;
      const matched=Object.keys(GAMES).find(key=>{
        const base=new URL(GAMES[key].base);return u.origin===base.origin&&u.pathname===base.pathname;
      });
      if(!matched)return invalid;
      if(matched!==game)return {...invalid,reason:'選択中のゲームと異なる交換URLです'};
      if([...u.searchParams.keys()].length!==1||!u.searchParams.has('code'))return {...invalid,reason:'交換URLにはcodeを1つだけ指定してください'};
      code=u.searchParams.get('code');url=true;
    }
    code=code.toUpperCase();
    return {code,url,reason:codeReason(code,game)};
  }
  function analyze(raw,game) {
    const result={codes:[],duplicates:0,urls:0,invalid:[],lineCount:0,charCount:typeof raw==='string'?raw.length:0,fatal:''};
    if (typeof raw!=='string' || raw.length>LIMITS.inputChars) return {...result,fatal:'入力は10,000文字までです。内容を減らしてください。'};
    if (typeof game!=='string' || !Object.hasOwn(GAMES,game)) return {...result,fatal:'ゲームを選択してください。'};
    const seen=new Set();
    raw.split(/\r\n|[\n\r]/).forEach((line,index)=>{
      if(!line.trim())return;result.lineCount++;
      const {code,url,reason}=codeInput(line,game);
      if(reason)result.invalid.push({line:index+1,reason});
      else {if(url)result.urls++;if(seen.has(code))result.duplicates++;
        else {seen.add(code);result.codes.push(code);}}
    });
    if(result.codes.length>LIMITS.codes){result.codes=[];result.fatal='コードは重複を除いて20件までです。件数を減らしてください。';}
    return result;
  }
  function webhookUrl(raw) {
    if(typeof raw!=='string' || raw.length>LIMITS.urlChars || raw!==raw.trim() || /[\s\\%]/.test(raw)) throw Error('Discord公式のWebhook URLを入力してください。');
    let u;try{u=new URL(raw);}catch{throw Error('Discord公式のWebhook URLを入力してください。');}
    if(u.protocol!=='https:' || !['discord.com','discordapp.com'].includes(u.hostname) || u.port || u.username || u.password || u.search || u.hash) throw Error('HTTPSのDiscord公式Webhook URLだけを使用できます。');
    const match=u.pathname.match(/^\/api\/webhooks\/([0-9]{5,25})\/([A-Za-z0-9_-]{20,200})\/?$/);
    if(!match || !/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\/[0-9]{5,25}\/[A-Za-z0-9_-]{20,200}\/?$/.test(raw)) throw Error('Webhook URLのパスを確認してください。');
    return {url:`https://discord.com/api/webhooks/${match[1]}/${match[2]}`,key:match[1]};
  }
  function name(value) {
    if(typeof value!=='string' || !value.trim() || value.length>LIMITS.nameChars || /[\u0000-\u001f\u007f]|https?:|api\/webhooks/i.test(value)) throw Error('表示名はURLを含まない1〜80文字にしてください。');
    return value.trim();
  }
  function normalizeWebhooks(value,{legacy=false,settingsOnly=false}={}) {
    if(!Array.isArray(value) || value.length>LIMITS.webhooks)throw Error('Webhookは10件以内の配列にしてください。');
    const seen=new Set(), ids=new Set();
    return value.map((v,i)=>{
      if(!v || typeof v!=='object' || Array.isArray(v))throw Error('Webhookのデータ形式が正しくありません。');
      const label=name(v.name);
      const game=v.game===undefined && legacy ? '' : v.game;
      if(typeof game!=='string' || (game!=='' && !Object.hasOwn(GAMES,game)))throw Error('対応ゲームが正しくありません。');
      if(v.enabled!==undefined && typeof v.enabled!=='boolean')throw Error('有効・無効の形式が正しくありません。');
      if(v.draft!==undefined && typeof v.draft!=='boolean')throw Error('URL未設定の形式が正しくありません。');
      if(v.id!==undefined && (!Number.isSafeInteger(v.id)||v.id<=0))throw Error('Webhook識別番号の形式が正しくありません。');
      let url='';
      if(!settingsOnly && v.url!=='')url=webhookUrl(v.url).url;
      if(!settingsOnly && v.url==='' && !v.draft)throw Error('Webhook URLがありません。');
      if(settingsOnly && v.url!==undefined)throw Error('設定のみのファイルにURLを含めないでください。');
      if(url){const key=webhookUrl(url).key;if(seen.has(key))throw Error('同じWebhookが重複しています。');seen.add(key);}
      let id=Number.isSafeInteger(v.id)&&v.id>0?v.id:Date.now()+i;
      while(ids.has(id))id++;ids.add(id);
      return {id,name:label,url,game,enabled:!!url&&!!game&&v.enabled!==false,draft:!url};
    });
  }
  function parseImport(text,bytes) {
    if(typeof text!=='string' || bytes>LIMITS.importBytes || new TextEncoder().encode(text).length>LIMITS.importBytes)throw Error('JSONファイルは100KBまでです。');
    let data;try{data=JSON.parse(text);}catch{throw Error('JSONの形式が正しくありません。');}
    if(Array.isArray(data))return normalizeWebhooks(data,{legacy:true});
    if(!data || data.version!==1 || !['webhooks','settings'].includes(data.kind))throw Error('対応する設定ファイルではありません。');
    return normalizeWebhooks(data.webhooks,{settingsOnly:data.kind==='settings'});
  }
  function lines(codes,game,prefix='#') {
    if(typeof game!=='string' || !Object.hasOwn(GAMES,game) || !Array.isArray(codes) || !codes.length || codes.length>LIMITS.codes || !['#','##','###',''].includes(prefix) || new Set(codes).size!==codes.length || codes.some(c=>typeof c!=='string'||codeReason(c,game)))throw Error('コードまたは出力形式を確認してください。');
    return codes.map(code=>({code,content:`${prefix?prefix+' ':''}[交換コード：${code}](${GAMES[game].base}${encodeURIComponent(code)})`}));
  }
  function messages(codes,game,prefix) {
    const chunks=[];let part={content:'',codes:[]};
    for(const row of lines(codes,game,prefix)){
      if(row.content.length>LIMITS.messageChars)throw Error('1つのコードが投稿上限を超えています。');
      if(part.content && part.content.length+1+row.content.length>LIMITS.messageChars){chunks.push(part);part={content:'',codes:[]};}
      part.content+=(part.content?'\n':'')+row.content;part.codes.push(row.code);
    }
    if(part.content)chunks.push(part);return chunks;
  }
  const api=Object.freeze({LIMITS,GAMES,gameFromBase,codeReason,analyze,webhookUrl,name,normalizeWebhooks,parseImport,lines,messages});
  globalThis.HoyoSafety=api;if(typeof module!=='undefined')module.exports=api;
})();
