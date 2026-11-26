/* ══════════════ STATE ══════════════ */
const STORAGE_KEY   = 'hoyo_webhooks_v3';
const HISTORY_KEY   = 'hoyo_history_v1';
const PREF_KEY      = 'hoyo_preferences_v1';
const S = HoyoSafety, L = S.LIMITS;
const HISTORY_LIMIT = L.history;

let webhooks = [];
let histories = [];
let failedDeliveries = [];
let sendBusy = false, settingsLoadIssue = '', inputOverflow = false;
let inputUndo = null;
let saveEnabled = true;
let currentBaseUrl   = '';
let currentGameLabel = 'ゼンゼロ';
const openedCodes = new Set();
const delivery = new HoyoDelivery.Delivery({persist:()=>saveEnabled,onStorageError:()=>storageWarning()});
const gameKey = () => S.gameFromBase(currentBaseUrl);
const gameIconName = key => ({zzz:'game-zzz',genshin:'game-genshin',hsr:'game-hsr'}[key]||'gift');
function syncGameTheme() { const key = gameKey(); if (key && document.body?.dataset) document.body.dataset.game = key; }
const targetKey = w => {try{return S.webhookUrl(w.url).key;}catch{return '';}};
const targetsForGame = () => webhooks.filter(w=>w.enabled && w.game===gameKey() && targetKey(w));
function boundedRead(key) { const raw=localStorage.getItem(key); if(raw && raw.length>L.storageChars) throw Error('保存データが大きすぎます。バックアップ後に読み込み直してください。'); return raw; }


/* ══════════════ INIT ══════════════ */
window.addEventListener('DOMContentLoaded', () => {
  loadPreferences();
  loadWebhooks();
  loadHistories();
  bindControls();
  setupWorkspace();
  const checked = document.querySelector('.game-radio:checked');
  if (checked) {
    currentBaseUrl   = checked.value;
    currentGameLabel = checked.closest('.game-label').querySelector('.game-nm').textContent;
  }
  syncGameTheme();
  document.getElementById('webhookGame').value=gameKey();
  setResultView(resultView,false);
  renderPreview();
  setInterval(updateSendState,1000);
  const hash = location.hash.slice(1);
  const initialTab = hash === 'settings' ? 'settings' : hash === 'help' || hash.startsWith('help-') ? 'help' : 'converter';
  switchTab(initialTab, null, false);
  if (hash.startsWith('help-')) requestAnimationFrame(() => document.getElementById(hash)?.scrollIntoView({ block: 'start' }));
  document.querySelector('.nav-tabs')?.addEventListener('keydown', e => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;
    const tabs = [...document.querySelectorAll('.nav-tab')];
    const current = tabs.indexOf(document.activeElement);
    if (current < 0) return;
    e.preventDefault();
    const direction = ['ArrowRight', 'ArrowDown'].includes(e.key) ? 1 : -1;
    const next = e.key === 'Home' ? tabs[0] : e.key === 'End' ? tabs.at(-1) : tabs[(current + direction + tabs.length) % tabs.length];
    next.focus();
    switchTab(next.dataset.tab, next);
  });
  document.querySelector('.preview-tabs')?.addEventListener('keydown', e => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const view = e.key === 'Home' ? 'links' : e.key === 'End' ? 'markdown' : resultView === 'links' ? 'markdown' : 'links';
    setResultView(view);
    document.getElementById(`view-${view}`).focus();
  });
});

let resultView = 'links';
function setResultView(view, persist=true) {
  if (!['links', 'markdown'].includes(view)) return;
  resultView = view;
  for (const key of ['links', 'markdown']) {
    const active = key === view;
    const button = document.getElementById(`view-${key}`);
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
  }
  document.getElementById('linkList').hidden = view !== 'links';
  document.getElementById('outputText').hidden = view !== 'markdown';
  for(const [id,active]of [['copyUrls',view==='links'],['copyMarkdown',view==='markdown']]){
    document.getElementById(id).classList.toggle('btn-primary',active);
    document.getElementById(id).classList.toggle('btn-secondary',!active);
  }
  document.querySelector('.heading-select').hidden=view!=='markdown';
  const actions=document.querySelector('.output-actions');
  actions.dataset.view=view;
  const first=document.getElementById(view==='links'?'copyUrls':'copyMarkdown');
  if(actions.firstElementChild!==first)actions.prepend(first);
  if(persist&&saveEnabled)storePreferences();
}

/* ══════════════ TAB ══════════════ */
function switchTab(id, btn, updateHash = true) {
  document.body.dataset.page=id;
  requestAnimationFrame(syncWorkspace);
  document.querySelectorAll('.tab-pane').forEach(p => {
    const isActive = p.id === `tab-${id}`;
    p.classList.toggle('active', isActive);
    p.setAttribute('aria-hidden', String(!isActive));
  });
  document.querySelectorAll('.nav-tab').forEach(b => {
    const isActive = b.dataset.tab === id;
    b.classList.toggle('active', isActive);
    b.setAttribute('aria-selected', String(isActive));
    b.tabIndex = isActive ? 0 : -1;
  });
  if (updateHash && location.hash!==`#${id}`) history.pushState(null, '', `#${id}`);
  if (id === 'converter') updateSendState();
}

function openHelp(anchor = 'help-start') {
  switchTab('help', null, false);
  if(location.hash!==`#${anchor}`)history.pushState(null, '', `#${anchor}`);
  requestAnimationFrame(() => document.getElementById(anchor)?.scrollIntoView({ block: 'start' }));
}

/* ══════════════ GAME SELECT ══════════════ */
function onGameChange(radio) {
  currentBaseUrl   = radio.value;
  currentGameLabel = radio.closest('.game-label').querySelector('.game-nm').textContent;
  syncGameTheme();
  if(!document.getElementById('webhookName').value&&!document.getElementById('webhookUrl').value)document.getElementById('webhookGame').value=gameKey();
  if(saveEnabled)storePreferences();
  renderPreview();
}

/* ══════════════ INPUT ANALYSIS ══════════════ */
function onCodesInput() { inputUndo=null;inputOverflow=false;renderPreview(); }
function analyzeCodes(raw) { const stats=S.analyze(raw,gameKey()); if(inputOverflow){stats.codes=[];stats.fatal='入力は10,000文字までです。貼り付ける内容を減らしてください。';} return stats; }
function renderCodeValidation(stats) {
  const el=document.getElementById('codeValidation');
  const notes=[];
  if(stats.urls)notes.push(`公式URL ${stats.urls}件を読み取り`);
  if(stats.duplicates)notes.push(`重複${stats.duplicates}件を除外`);
  if(stats.invalid.length)notes.push(`不正${stats.invalid.length}件を除外：`+stats.invalid.slice(0,3).map(r=>`${r.line}行目 ${r.reason}`).join('／')+(stats.invalid.length>3?' ほか':''));
  document.getElementById('codeCount').textContent=`${stats.codes.length} / 20コード`;
  document.getElementById('charCount').textContent=`${stats.charCount.toLocaleString()} / 10,000文字`;
  const meter=document.getElementById('inputMeter'),fill=document.getElementById('inputMeterFill');
  if(meter&&fill){
    const pct=stats.fatal?100:Math.min(100,Math.round((stats.codes.length/L.codes)*100));
    fill.style?.setProperty('width',`${pct}%`);
    meter.dataset.state=stats.fatal||stats.invalid.length?'err':stats.codes.length>=16?'warn':'ok';
  }
  el.textContent=stats.fatal || notes.join(' ・ ');
  el.className=`input-status ${stats.fatal||stats.invalid.length?'err':stats.duplicates?'warn':'neutral'}`;
  el.title='';document.getElementById('inputText').setAttribute('aria-invalid',String(!!stats.fatal||!!stats.invalid.length));
}
async function pasteCodes() {
  const ta=document.getElementById('inputText');
  try { const text=await navigator.clipboard.readText(); if(!text.trim())return showToast('クリップボードが空です','warn');
    const next=ta.value+(ta.value&&!ta.value.endsWith('\n')?'\n':'')+text;
    if(next.length>L.inputChars){inputOverflow=true;renderPreview();return showToast('10,000文字を超えるため貼り付けを中止しました。内容を減らしてください。','err');}
    ta.value=next;onCodesInput();ta.focus();
  }catch{ta.focus();showToast('入力欄で Ctrl+V を使用してください','warn');}
}

/* ══════════════ RENDER PREVIEW ══════════════ */
function renderPreview() {
  const raw = document.getElementById('inputText').value;
  const stats = analyzeCodes(raw);
  const codes = stats.codes;
  const rs = document.getElementById('resultSection');
  const sendRow = document.getElementById('sendRow');
  const inputPanel = document.getElementById('inputPanel');
  const outputPanel = document.getElementById('outputPanel');
  const resultCount = document.getElementById('resultCount');
  renderCodeValidation(stats);
  updateInputActions(stats);
  resultCount.textContent = `${codes.length}件`;
  if (resultCount.dataset) resultCount.dataset.hasItems = String(codes.length > 0);
  if (inputPanel?.dataset) inputPanel.dataset.stepState = codes.length ? 'done' : 'active';
  if (outputPanel?.dataset) outputPanel.dataset.stepState = codes.length ? 'done' : 'idle';
  document.getElementById('workspaceResultCount').textContent=String(codes.length);
  document.getElementById('copyMarkdown').disabled = !codes.length;
  document.getElementById('copyUrls').disabled = !codes.length;
  const jump=document.getElementById('jumpResults');jump.hidden=!codes.length;
  jump.textContent=`結果を見る ${codes.length}件`;
  const empty=rs.querySelector('.result-empty');
  empty.querySelector('p').textContent=stats.fatal?'入力を見直してください':stats.invalid.length&&!codes.length?'使えるコードがありません':'コードを貼ると、リンクが表示されます';
  empty.querySelector('span').textContent=stats.fatal?'入力欄のメッセージを確認し、内容を減らしてください。':stats.invalid.length&&!codes.length?'半角英数字のコードを1行ずつ入力してください。':'作品を選び、コードか公式の交換URLを入力してください。';
  updateSendState();

  if (!codes.length || !currentBaseUrl) {
    rs.classList.remove('show');
    document.getElementById('outputText').textContent = '';
    document.getElementById('linkList').replaceChildren();
    return;
  }

  const prefix = document.getElementById('headingSelect')?.value ?? '#';
  const gKey = gameKey();
  let md = '', html = '';
  codes.forEach(code => {
    const link = `${currentBaseUrl}${encodeURIComponent(code)}`;
    const isOpened = openedCodes.has(`${gKey}:${code}`);
    md += prefix ? `${prefix} [交換コード：${code}](${link})\n` : `[交換コード：${code}](${link})\n`;
    html += `<div class="code-row" data-code="${esc(code)}" data-link="${esc(link)}" data-opened="${isOpened?'true':'false'}">
      <div class="code-info"><div class="code-head"><span class="code-text" translate="no">${esc(code)}</span><span class="code-opened-tag">開済</span></div><span class="code-url" translate="no">${esc(link)}</span></div>
      <div class="code-actions">
        <button class="code-action" type="button" data-action="link" aria-label="${esc(code)}のリンクをコピー" title="リンクをコピー">${iconSvg('copy')}<span class="row-action-label">コピー</span></button>
        <a href="${esc(link)}" target="_blank" rel="noopener noreferrer" class="code-open" data-open-code="${esc(code)}" aria-label="${esc(code)}の交換ページを開く" title="交換ページを開く">${iconSvg('external')}<span class="row-action-label">開く</span></a>
      </div>
    </div>`;
  });

  document.getElementById('outputText').textContent = md.trim();
  document.getElementById('linkList').innerHTML = html;
  rs.classList.add('show');
  sendRow.classList.remove('hidden');
}

/* ══════════════ COPY ══════════════ */
async function copyText(btn) {
  const snapshot = getOutputSnapshot();
  if (!snapshot.codes.length) return;
  if (!await copyToClipboard(snapshot.markdown)) return showToast('コピーに失敗しました。結果を選択してコピーしてください。', 'err');
  saveHistory(snapshot.markdown, snapshot.codes, snapshot);
  copyFeedback(btn);
}

async function copyLinkValue(btn) {
  const row = btn.closest('.code-row');
  const value = row?.dataset.link;
  if (!value) return;
  if (!await copyToClipboard(value)) return showToast('コピーに失敗しました', 'err');
  copyFeedback(btn);
}

/* ══════════════ DISCORD SEND ══════════════ */
function sendToDiscord() {
  if(sendBusy)return;
  try {
    const snapshot=getOutputSnapshot(),targets=targetsForGame().map(w=>({...w}));
    if(!snapshot.codes.length)throw Error('入力内容を確認してください。');
    if(!targets.length)throw Error('対応ゲームを設定した送信先を有効にしてください。');
    const items=targets.flatMap(target=>S.messages(snapshot.codes,snapshot.gameKey,snapshot.prefix).map(chunk=>({...chunk,target,game:snapshot.gameKey,prefix:snapshot.prefix})));
    reviewPlan({kind:'normal',items,snapshot});
  }catch(error){showToast(error.message,'warn');}
}
function reviewPlan(plan) {
  const keys=delivery.validatePlan(plan),left=delivery.remaining(plan.kind,keys);
  if(left)return showToast(`あと${Math.ceil(left/1000)}秒お待ちください。`,'warn');
  const repeats=plan.kind==='test'?[]:delivery.repeats(plan.items);
  const names=[...new Set(plan.items.map(i=>i.target.name))];
  const count=new Set(plan.items.flatMap(i=>i.codes)).size;
  const body=[plan.kind==='test'?'接続確認を1投稿送信します。':`対象ゲーム：${S.GAMES[plan.items[0].game].name}\nコード：${count}件`,
    `送信先：${names.join('・')}\n実際の投稿数：${plan.items.length}件`,
    repeats.length?`送信済みのコードと送信先の組み合わせが${repeats.length}件あります。再告知として送信しますか？`:'',
    plan.kind==='retry'?'未送信・失敗分だけを再送します。通信切断時は届いている可能性があるため、チャンネルを確認してください。':'',
    failedDeliveries.length&&plan.kind==='normal'?'前回の再送待ちを今回の送信結果で置き換えます。':''].filter(Boolean).join('\n\n');
  plan.reviewedAt=Date.now();
  showModal(plan.kind==='test'?'テスト送信':plan.kind==='retry'?'失敗分を再送':'Discordへ送信',body,()=>executePlan(plan),repeats.length?'それでも送信':'送信する');
}
async function executePlan(plan) {
  if(sendBusy)return;
  for(const item of plan.items){const current=webhooks.find(w=>w.id===item.target.id);
    if(!current||current.url!==item.target.url||current.game!==item.target.game||(plan.kind!=='test'&&!current.enabled))return showToast('送信先が変更されました。内容を確認し直してください。','warn');
  }
  sendBusy=true;updateSendState();
  const status=document.getElementById('deliveryStatus');status.textContent='送信中…';status.className='input-status neutral';
  try {
    const result=await delivery.run(plan,(item,r)=>{
      appendLog(item.target.name,r.message,r.ok);
      if(r.dead){const w=webhooks.find(w=>w.id===item.target.id);if(w)w.enabled=false;saveWebhooks();}
    },(done,total)=>{status.textContent=`送信中… ${done} / ${total}投稿`;});
    if(plan.kind!=='test')failedDeliveries=result.failed;
    if(result.ok&&plan.snapshot)saveHistory(plan.snapshot.markdown,plan.snapshot.codes,plan.snapshot);
    const labels={success:'送信成功',partial:'一部送信成功',error:'送信失敗'};
    status.textContent=`${labels[result.state]}：${result.ok} / ${result.total}投稿${result.failed.length?'。失敗分はDiscord設定の「ログ」から再送できます。':''}`;
    status.className=`input-status ${result.state==='success'?'ok':result.state==='partial'?'warn':'err'}`;
    showToast(status.textContent,result.state==='success'?'ok':'warn');
  }catch(error){status.textContent=error.message;status.className='input-status err';showToast(error.message,'warn');}
  finally{sendBusy=false;updateSendState();renderWebhooks();}
}
function retryFailedWebhooks() {
  if(sendBusy||!failedDeliveries.length)return;
  try{reviewPlan({kind:'retry',items:failedDeliveries.map(i=>({...i,target:{...i.target},codes:[...i.codes]}))});}catch(error){showToast(error.message,'warn');}
}
function updateRetryButton() {
  const btn=document.getElementById('retryFailedBtn');if(!btn)return;
  const left=delivery.remaining('retry',failedDeliveries.map(i=>targetKey(i.target)));
  btn.disabled=sendBusy||left>0;btn.classList.toggle('hidden',!failedDeliveries.length);
  btn.innerHTML=`${iconSvg('retry')}<span>${left?`あと${Math.ceil(left/1000)}秒`:`失敗分を再送 ${failedDeliveries.length}`}</span>`;
}
function testWebhook(id) {
  const target=webhooks.find(w=>w.id===id);if(!target||sendBusy)return;
  try{reviewPlan({kind:'test',items:[{target:{...target},content:'HoyoGift Hub 接続確認',codes:[]}]});}catch(error){showToast(error.message,'warn');}
}

/* ══════════════ WEBHOOKS ══════════════ */
function loadPreferences() {
  try {
    const saved = JSON.parse(boundedRead(PREF_KEY) || '{}');
    if(!saved || typeof saved!=='object' || Array.isArray(saved) || (saved.saveEnabled!==undefined&&typeof saved.saveEnabled!=='boolean'))throw Error();
    saveEnabled = saved.saveEnabled !== false;
    if(saveEnabled){
      if(typeof saved.game==='string'&&Object.hasOwn(S.GAMES,saved.game))for(const radio of document.querySelectorAll('.game-radio'))radio.checked=radio.value===S.GAMES[saved.game].base;
      if(['links','markdown'].includes(saved.view))resultView=saved.view;
      if(['#','##','###',''].includes(saved.heading))document.getElementById('headingSelect').value=saved.heading;
    }
  } catch { saveEnabled = false; }
  const toggle = document.getElementById('persistenceToggle');
  if (toggle) toggle.checked = saveEnabled;
  updateStorageModeUI();
}

function storePreferences() {
  storageWrite(PREF_KEY, { saveEnabled, ...(saveEnabled?{game:gameKey(),view:resultView,heading:document.getElementById('headingSelect').value}:{}) });
}

function loadWebhooks() {
  webhooks=[];settingsLoadIssue='';
  if(saveEnabled)try {const raw=boundedRead(STORAGE_KEY);if(raw)webhooks=S.normalizeWebhooks(JSON.parse(raw),{legacy:true});}
  catch{settingsLoadIssue='保存データを安全に読み込めませんでした。元のデータは保持しています。「保存・移行」からURL付きバックアップを書き出し、正しいJSONを読み込むか全データを削除してください。';}
  else {storageRemove(STORAGE_KEY);storageRemove(HISTORY_KEY);delivery.forgetSent();}
  renderWebhooks();
}
function saveWebhooks(refresh=true) {
  if(settingsLoadIssue)return;
  if(saveEnabled)storageWrite(STORAGE_KEY,webhooks);
  if(refresh)renderWebhooks();updateSendState();
}

function togglePersistence(enabled) {
  const toggle = document.getElementById('persistenceToggle');
  if (enabled) {
    saveEnabled = true;
    storePreferences();
    if(!settingsLoadIssue)storageWrite(STORAGE_KEY, webhooks);
    storageWrite(HISTORY_KEY, histories);
    updateStorageModeUI();
    return showToast('ブラウザ保存を有効にしました', 'ok');
  }
  toggle.checked = true;
  showModal('ブラウザ保存を停止', '保存済みのWebhookと履歴を削除し、以後は現在のタブを閉じるまでだけ保持します。', () => {
    saveEnabled = false;
    toggle.checked = false;
    storePreferences();
    storageRemove(STORAGE_KEY);
    storageRemove(HISTORY_KEY);
    delivery.forgetSent();
    histories = [];
    renderHistories();
    updateStorageModeUI();
    showToast('保存しないモードに切り替えました', 'info');
  });
}

function updateStorageModeUI() {
  const status=document.getElementById('storageStatusBtn');
  if(status){
    document.getElementById('storageStatusText').textContent=saveEnabled?'保存ON':'保存OFF';
    status.setAttribute('aria-label',saveEnabled?'保存ON：設定と履歴をこのブラウザに保存。データ管理を開く':'保存OFF：設定はこのタブ内だけで保持。データ管理を開く');
    status.classList.toggle('storage-off',!saveEnabled);
  }
  const sidebar = document.getElementById('sidebarStorageState');
  if (sidebar) sidebar.textContent = saveEnabled ? '設定と履歴は、このブラウザに保存されます。' : '保存OFF。設定はこのタブ内でのみ保持します。';
  const help = document.getElementById('storageModeHelp');
  if (!help) return;
  help.textContent = saveEnabled
    ? 'Webhookと履歴をこのブラウザに保存します。'
    : '保存OFF：Webhookは現在のタブ内だけ保持し、履歴は記録しません。';
  help.textContent+=' 送信済み記録は保存ON時のみ最大30日・1,000件。連打防止用の時刻とWebhook識別番号は保存OFFでも共有します。URLは運営サーバーへ送信しません。';
  help.classList.toggle('storage-off', !saveEnabled);
}

function clearAllData() {
  if (sendBusy) return showToast('送信完了後に削除してください', 'warn');
  showModal('全ローカルデータを削除', 'Webhook、作成履歴、送信ログ、入力中のコードを削除します。連打防止用の時刻は残ります。この操作は取り消せません。', () => {
    [STORAGE_KEY, HISTORY_KEY, PREF_KEY].forEach(storageRemove);
    delivery.forgetSent();settingsLoadIssue='';inputOverflow=false;inputUndo=null;
    webhooks = [];
    histories = [];
    failedDeliveries = [];
    saveEnabled = true;
    document.getElementById('persistenceToggle').checked = true;
    document.getElementById('webhookName').value = '';
    document.getElementById('webhookUrl').value = '';
    document.getElementById('inputText').value = '';
    renderWebhooks();
    renderHistories();
    renderPreview();
    clearLog(false);
    updateRetryButton();
    updateStorageModeUI();
    showToast('すべてのローカルデータを削除しました', 'ok');
  });
}
function addWebhook() {
  if(sendBusy||settingsLoadIssue)return;
  const error=document.getElementById('webhookError');error.textContent='';
  const validName=validateNewWebhookField(document.getElementById('webhookName'));
  const validUrl=validateNewWebhookField(document.getElementById('webhookUrl'));
  if(!validName||!validUrl){document.getElementById(!validName?'webhookName':'webhookUrl').focus();return;}
  try {
    if(webhooks.length>=L.webhooks)throw Error('Webhookは10件までです。不要な送信先を削除してください。');
    const w={id:nextWebhookId(),name:S.name(document.getElementById('webhookName').value),url:S.webhookUrl(document.getElementById('webhookUrl').value).url,game:document.getElementById('webhookGame').value,enabled:true};
    webhooks=S.normalizeWebhooks([...webhooks,w]);saveWebhooks();
    document.getElementById('webhookName').value='';document.getElementById('webhookUrl').value='';error.textContent='';setSettingsView('list');showToast('送信先を登録しました','ok');
  }catch(e){error.textContent=e.message;showToast(e.message,'err');}
}
function updateWebhook(id,key,val) {
  if(sendBusy||settingsLoadIssue||!['name','url','game','enabled'].includes(key))return;
  const w=webhooks.find(h=>h.id===id);if(!w)return;
  try {
    if(key==='url')val=S.webhookUrl(val).url;
    if(key==='name')val=S.name(val);
    if(key==='enabled'&&val&&(!w.url||!w.game))throw Error('先にURLと対応ゲームを設定してください。');
    const candidate={...w,[key]:val};if(key==='url')candidate.draft=false;
    const next=S.normalizeWebhooks(webhooks.map(h=>h.id===id?candidate:h));
    if(key==='url')delivery.resetTarget(val);
    webhooks=next;saveWebhooks(false);refreshWebhookCard(id);
    const card=document.querySelector(`.wh-item[data-webhook-id="${id}"]`);card.querySelector('.wh-error').textContent='';
    const control=card.querySelector(`[data-edit="${key}"]`);control.removeAttribute('aria-invalid');
  }catch(e){
    const card=document.querySelector(`.wh-item[data-webhook-id="${id}"]`),control=card?.querySelector(`[data-edit="${key}"]`);
    if(control){if(key==='enabled')control.checked=w.enabled;else control.value=w[key];control.setAttribute('aria-invalid','true');}
    if(card)card.querySelector('.wh-error').textContent=e.message;
  }
}
function deleteWebhook(id) {
  if(sendBusy)return;const w=webhooks.find(h=>h.id===id);if(!w)return;
  showModal('送信先を削除',`「${w.name}」を削除しますか？`,()=>{if(sendBusy)return;webhooks=webhooks.filter(h=>h.id!==id);saveWebhooks();});
}
function toggleAll(state) {
  if(sendBusy||settingsLoadIssue)return;
  webhooks.forEach(w=>w.enabled=!!state&&!!w.url&&!!w.game);saveWebhooks();
}
function gameOptions(game) {return `<option value="" ${game===''?'selected':''}>ゲームを設定</option>`+Object.entries(S.GAMES).map(([key,g])=>`<option value="${key}" ${game===key?'selected':''}>${g.name}</option>`).join('');}
function renderWebhooks() {
  const list=document.getElementById('webhookList');if(!list)return;
  const open=new Set([...list.querySelectorAll('details[open]')].map(el=>el.dataset.editor));
  document.getElementById('settingsIssue').textContent=settingsLoadIssue;
  document.getElementById('webhookCount').textContent=`${webhooks.length} / 10件`;
  for (const btn of document.querySelectorAll('[data-action="allOn"],[data-action="allOff"]')) btn.disabled = !webhooks.length;
  const badge=document.getElementById('whBadge');badge.textContent=webhooks.filter(w=>w.enabled).length;badge.style.display=webhooks.length?'':'none';
  if(!webhooks.length){list.innerHTML=`<div class="empty">${iconSvg('webhook','empty-icon')}<p>送信先がまだありません</p><span>作品ごとの Webhook を登録すると、作成したリンクをワンクリックで送信できます。</span><button type="button" class="btn btn-primary empty-cta" data-action="newWebhook">${iconSvg('webhook')}<span>最初の送信先を登録</span></button></div>`;return;}
  list.innerHTML=webhooks.map(h=>`<div class="wh-item${h.enabled?'':' off'}" data-webhook-id="${h.id}">
    <div class="wh-card-head"><span class="wh-game-mark" data-game="${esc(h.game)}" data-summary-mark>${h.game?iconSvg(gameIconName(h.game)):''}<span>${esc(S.GAMES[h.game]?.short||'未設定')}</span></span><div class="wh-card-title"><strong data-summary-name>${esc(h.name)}</strong><span data-summary-state>${h.enabled?'送信ON':'送信OFF'}</span></div>
    <div class="wh-head-actions"><button class="io-btn test" type="button" data-action="test" data-id="${h.id}" ${!h.url?'disabled':''} aria-label="${esc(h.name)}へテスト送信">テスト送信</button><label class="wh-switch"><input type="checkbox" ${h.enabled?'checked':''} data-edit="enabled" data-id="${h.id}" aria-label="${esc(h.name)}を有効にする"><span class="switch-track" aria-hidden="true"></span></label></div></div>
    <p class="input-status warn wh-setup-note" ${h.game&&h.url?'hidden':''}>URLと対応ゲームを設定してから有効にしてください。</p>
    <div class="wh-card-tools"><details class="wh-editor" data-editor="${h.id}" ${open.has(String(h.id))||!h.game||!h.url?'open':''}><summary>${iconSvg('settings')}<span>編集</span>${iconSvg('down','icon edit-chevron')}</summary>
      <div class="wh-editor-fields"><label class="field">表示名<input class="cyber-input wh-name-inp" maxlength="80" value="${esc(h.name)}" data-edit="name" data-id="${h.id}" aria-label="Webhookの表示名" autocomplete="off"></label>
      <label class="field">対応ゲーム<select class="cyber-input" data-edit="game" data-id="${h.id}" aria-label="${esc(h.name)}の対応ゲーム">${gameOptions(h.game)}</select></label>
      <div class="field field-wide"><label for="wu${h.id}">Webhook URL</label><div class="wh-url-wrap"><input type="password" id="wu${h.id}" class="wh-url-inp" maxlength="300" value="${esc(h.url)}" data-edit="url" data-id="${h.id}" aria-label="${esc(h.name)}のWebhook URL" autocomplete="off" spellcheck="false"><button class="wh-eye" type="button" data-action="eye" data-field="wu${h.id}" aria-label="Webhook URLを表示">${iconSvg('eye')}</button></div></div>
      <p class="field-error wh-error field-wide" aria-live="polite"></p><div class="wh-editor-footer field-wide"><span>変更は入力欄を離れると反映されます。</span><button class="ico-btn del" type="button" data-action="deleteWebhook" data-id="${h.id}" aria-label="${esc(h.name)}を削除">${iconSvg('trash')}</button></div></div>
    </details></div></div>`).join('');
  updateSendState();
}
function refreshWebhookCard(id){
  const w=webhooks.find(w=>w.id===id),card=document.querySelector(`.wh-item[data-webhook-id="${id}"]`);if(!w||!card)return;
  card.classList.toggle('off',!w.enabled);card.querySelector('[data-summary-name]').textContent=w.name;
  const mark=card.querySelector('[data-summary-mark]');
  mark.dataset.game=w.game||'';
  mark.innerHTML=`${w.game?iconSvg(gameIconName(w.game)):''}<span>${esc(S.GAMES[w.game]?.short||'未設定')}</span>`;
  card.querySelector('[data-summary-state]').textContent=w.enabled?'送信ON':'送信OFF';
  card.querySelector('.wh-setup-note').hidden=!!w.url&&!!w.game;
  for(const input of card.querySelectorAll('[data-edit]')){if(input.type==='checkbox')input.checked=w.enabled;else input.value=w[input.dataset.edit];}
  card.querySelector('[data-edit="enabled"]').setAttribute('aria-label',`${w.name}を有効にする`);
  card.querySelector('[data-action="test"]').setAttribute('aria-label',`${w.name}へテスト送信`);
  updateSendState();
}
function validateNewWebhookField(input){
  if(!['webhookName','webhookUrl'].includes(input.id))return true;
  const error=document.getElementById(input.id+'Error');
  try{if(input.id==='webhookName')S.name(input.value);else S.webhookUrl(input.value);error.textContent='';input.removeAttribute('aria-invalid');return true;}
  catch(e){error.textContent=e.message;input.setAttribute('aria-invalid','true');return false;}
}

/* ══════════════ IMPORT / EXPORT ══════════════ */
function downloadSettings(data,label) {
  const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
  const a=Object.assign(document.createElement('a'),{href:url,download:`hoyo_${label}_${new Date().toISOString().slice(0,10)}.json`});a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function exportWebhooks(includeUrls=false) {
  if(includeUrls)return showModal('秘密情報を含むバックアップ', 'Webhook URLには投稿権限があります。JSONにURLが含まれます。公開・共有せず、安全な場所に保管してください。',()=>{
    if(settingsLoadIssue){try{const raw=boundedRead(STORAGE_KEY);downloadSettings(JSON.parse(raw),'original_backup');}catch{showToast('書き出せませんでした。ブラウザの保存データを確認してください。','err');}return;}
    downloadSettings({version:1,kind:'webhooks',webhooks},'private_backup');
  },'URL付きで書き出す');
  if(settingsLoadIssue)return showToast('元のデータはURL付きバックアップで保存してください。','warn');
  downloadSettings({version:1,kind:'settings',webhooks:webhooks.map(({id,name,game})=>({id,name,game,enabled:false}))},'settings');
}
function importWebhooks(e) {
  const input=e.target,f=input.files[0];if(!f)return;
  input.value='';if(sendBusy)return;
  if(f.size>L.importBytes)return showToast('JSONは100KBまでです。ファイルを小さくしてください。','err');
  const reader=new FileReader();
  reader.onload=()=>{try {
    const next=S.parseImport(reader.result,f.size);
    showModal('設定を読み込み',`${next.length}件の設定で現在の登録を置き換えます。ゲーム未設定・URLなしの送信先は無効になります。`,()=>{
      if(sendBusy)return;webhooks=next;settingsLoadIssue='';failedDeliveries=[];saveWebhooks();setSettingsView('list');showToast('設定を読み込みました','ok');
    },'読み込む');
  }catch(error){showToast(error.message,'err');}};
  reader.onerror=()=>showToast('ファイルを読み込めませんでした。既存設定は保持しています。','err');reader.readAsText(f,'UTF-8');
}

/* ══════════════ LOG ══════════════ */
function appendLog(name, msg, ok) {
  const area = document.getElementById('logArea');
  area.querySelector('.empty')?.remove();
  const row = document.createElement('div');
  row.className = `log-row ${ok ? 'ok' : 'err'}`;
  row.innerHTML = `<span class="log-time">[${new Date().toLocaleTimeString('ja-JP')}]</span><span class="log-name">${esc(name)}</span><span>${esc(msg)}</span>`;
  area.appendChild(row);
  while(area.children.length>L.logRows)area.firstElementChild.remove();
  area.scrollTop = area.scrollHeight;
}
function clearLog(notify = true) {
  if (sendBusy) return showToast('送信完了後にログを消去してください', 'warn');
  document.getElementById('logArea').innerHTML = `<div class="empty">${iconSvg('log', 'empty-icon')}<p>送信ログはまだありません</p><span>テスト送信や一括送信の結果を表示します。</span></div>`;
  failedDeliveries = [];
  updateRetryButton();
  if (notify) showToast('ログをクリアしました', 'info');
}

/* ══════════════ HISTORY ══════════════ */
function loadHistories() {
  histories=[];
  if(saveEnabled)try {
    const value=JSON.parse(boundedRead(HISTORY_KEY)||'[]');
    if(!Array.isArray(value)||value.length>L.history)throw Error();
    histories=value.flatMap(h=>{try{
      const game=S.gameFromBase(h.baseUrl);if(!Number.isSafeInteger(h.id)||!Number.isFinite(Date.parse(h.timestamp)))return [];
      const markdown=S.lines(h.codes,game,'#').map(r=>r.content).join('\n');
      return [{id:h.id,timestamp:h.timestamp,game:S.GAMES[game].name,baseUrl:h.baseUrl,codes:[...h.codes],markdown}];
    }catch{return [];}});
  }catch{showToast('一部の履歴を読み込めませんでした。','warn');}
  renderHistories();
}

function saveHistory(markdown, codes, snapshot = {game:currentGameLabel, baseUrl:currentBaseUrl}) {
  if (!saveEnabled) return;
  const codeKey = codes.join('\n');
  histories = histories.filter(h => !(h.game === snapshot.game && h.codes.join('\n') === codeKey));
  histories.unshift({ id: Math.max(Date.now(), ...histories.map(h=>h.id+1)), timestamp: new Date().toISOString(), game: snapshot.game, baseUrl: snapshot.baseUrl, codes, markdown });
  if (histories.length > HISTORY_LIMIT) histories = histories.slice(0, HISTORY_LIMIT);
  storageWrite(HISTORY_KEY, histories);
  renderHistories();
  updateHistoryBadge();
}
function deleteHistory(id) {
  histories = histories.filter(h => h.id !== id);
  if (saveEnabled) storageWrite(HISTORY_KEY, histories);
  renderHistories(); updateHistoryBadge();
  showToast('削除しました', 'info');
}
function clearHistory() {
  showModal('履歴を全削除', 'すべての作成履歴を削除しますか？', () => {
    histories = [];
    storageRemove(HISTORY_KEY);
    renderHistories(); updateHistoryBadge();
    showToast('履歴をクリアしました', 'info');
  });
}
function restoreHistory(id) {
  inputUndo=null;
  setConverterView('input');
  const h = histories.find(x => x.id === id); if (!h) return;
  document.querySelectorAll('.game-radio').forEach(r => {
    if (r.value === h.baseUrl) { r.checked = true; currentBaseUrl = h.baseUrl; currentGameLabel = h.game; }
  });
  syncGameTheme();
  inputOverflow=false;document.getElementById('inputText').value = h.codes.join('\n');
  renderPreview();
  switchTab('converter', null);
  showToast(`「${h.game}」の履歴を復元しました`, 'ok');
}
function updateHistoryBadge() {
  const badge = document.getElementById('histBadge'); if (!badge) return;
  if (histories.length) {
    badge.style.display = ''; badge.textContent = histories.length;
  } else { badge.style.display = 'none'; }
}
function renderHistories() {
  const list = document.getElementById('historyList'); if (!list) return;
  updateHistoryBadge();
  if (!histories.length) {
    list.innerHTML = saveEnabled
      ? `<div class="empty">${iconSvg('history', 'empty-icon')}<p>作成履歴はまだありません</p><span>リンクをコピーまたは送信すると自動で記録されます。</span><button type="button" class="btn btn-secondary empty-cta" data-action="converterView" data-view="input">${iconSvg('wand')}<span>リンク作成へ戻る</span></button></div>`
      : `<div class="empty">${iconSvg('database', 'empty-icon')}<p>履歴保存はOFFです</p><span>保存・移行からブラウザ保存を有効にすると履歴が記録されます。</span><button type="button" class="btn btn-secondary empty-cta" data-action="storageSettings">${iconSvg('database')}<span>データ管理を開く</span></button></div>`;
    return;
  }
  list.innerHTML = '';
  histories.forEach(h => {
    const dt   = new Date(h.timestamp);
    const date = dt.toLocaleDateString('ja-JP', { year:'numeric', month:'2-digit', day:'2-digit' });
    const time = dt.toLocaleTimeString('ja-JP', { hour:'2-digit', minute:'2-digit' });
    const gKey = S.gameFromBase(h.baseUrl);
    const el = document.createElement('div');
    el.className = 'hist-item';
    el.innerHTML = `
      <div class="hist-header">
        <div class="hist-meta">
          <span class="hist-game" data-game="${esc(gKey)}">${iconSvg(gameIconName(gKey))}<span>${esc(h.game)}</span></span>
          <span class="hist-time">${date} ${time}</span>
        </div>
        <div class="hist-actions">
          <button class="io-btn" type="button" data-action="restore" data-id="${h.id}" aria-label="${esc(h.game)}の履歴を復元" title="復元">${iconSvg('restore')}<span>使う</span></button>
          <button class="ico-btn del" type="button" data-action="deleteHistory" data-id="${h.id}" aria-label="${esc(h.game)}の履歴を削除" title="削除">${iconSvg('trash')}</button>
        </div>
      </div>
      <div class="hist-codes">${h.codes.map(c => `<span class="hist-code" translate="no">${esc(c)}</span>`).join('')}</div>`;
    list.appendChild(el);
  });
}

/* ══════════════ TOAST ══════════════ */
function showToast(msg, type = 'info') {
  const map = { ok:'t-ok', err:'t-err', info:'t-info', warn:'t-warn' };
  const ico = { ok:'check', err:'close', info:'info', warn:'info' };
  const el = document.createElement('div');
  el.className = `toast ${map[type] || 't-info'}`;
  el.innerHTML = `<span class="t-ico">${iconSvg(ico[type]||'info')}</span><span>${esc(msg)}</span>`;
  document.getElementById('toast-root').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 180); }, 3000);
}

/* ══════════════ MODAL ══════════════ */
let _mcb = null;
let _lastFocus = null;
function showModal(title, body, cb, confirmLabel = '実行する') {
  _lastFocus = document.activeElement;
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalBody').textContent = body;
  document.getElementById('modalOk').textContent = confirmLabel;
  document.getElementById('app').inert = true;
  _mcb = cb;
  document.getElementById('modalOk').onclick = () => { const action = _mcb; _mcb = null; closeModal(); Promise.resolve(action?.()).catch(()=>showToast('処理に失敗しました。再度お試しください', 'err')); };
  document.getElementById('modal-root').classList.add('open');
  document.querySelector('#modal-root .modal-acts button').focus();
}
function closeModal() {
  document.getElementById('modal-root').classList.remove('open');
  document.getElementById('app').inert = false;
  _mcb = null;
  _lastFocus?.focus?.();
}
document.getElementById('modal-root').addEventListener('click', e => { if (e.target === e.currentTarget) closeModal(); });
document.addEventListener('keydown', e => {
  const root = document.getElementById('modal-root');
  if (!root.classList.contains('open')) return;
  if (e.key === 'Escape') return closeModal();
  if (e.key !== 'Tab') return;
  const focusable = [...root.querySelectorAll('button:not(:disabled), [href], input:not(:disabled), [tabindex]:not([tabindex="-1"])')];
  if (!focusable.length) return;
  const first = focusable[0], last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

/* ══════════════ UTILS ══════════════ */
function updateInputActions(stats=analyzeCodes(document.getElementById('inputText').value)) {
  const raw=document.getElementById('inputText').value;
  document.getElementById('normalizeInputBtn').disabled=!!stats.fatal||!stats.codes.length||raw===stats.codes.join('\n');
  document.getElementById('undoInputBtn').disabled=inputUndo===null;
}
function replaceInput(value) {
  const input=document.getElementById('inputText');
  if(input.value===value){inputOverflow=false;renderPreview();return;}
  inputUndo=input.value.length<=L.inputChars?input.value:null;
  input.value=value;inputOverflow=false;renderPreview();input.focus({preventScroll:true});
}
function normalizeInput() {
  const stats=analyzeCodes(document.getElementById('inputText').value);
  if(stats.fatal||!stats.codes.length)return;
  replaceInput(stats.codes.join('\n'));
}
function undoInput() {
  if(inputUndo===null)return;
  const value=inputUndo;inputUndo=null;inputOverflow=false;
  document.getElementById('inputText').value=value;renderPreview();
  document.getElementById('inputText').focus({preventScroll:true});
}
function clearField(id) { if(id==='inputText')return replaceInput('');document.getElementById(id).value=''; }
function togglePw(id, btn) {
  const el = document.getElementById(id); if (!el) return;
  el.type = el.type === 'password' ? 'text' : 'password';
  if (btn) {
    const isHidden = el.type === 'password';
    btn.innerHTML = iconSvg(isHidden ? 'eye' : 'eye-off');
    btn.setAttribute('aria-label', isHidden ? 'Webhook URLを表示' : 'Webhook URLを隠す');
  }
}
async function copyToClipboard(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  const helper = document.createElement('textarea');
  helper.value = text;
  helper.setAttribute('readonly', '');
  helper.style.position = 'fixed';
  helper.style.opacity = '0';
  document.body.appendChild(helper);
  helper.select();
  try { return document.execCommand('copy'); }
  catch { return false; }
  finally { helper.remove(); }
}
function iconSvg(name, className = 'icon') { return `<svg class="${className}" aria-hidden="true"><use href="#icon-${name}"></use></svg>`; }
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }


/* Site additions: browser-only storage and output controls. */
function getOutputSnapshot() {
  const codes=analyzeCodes(document.getElementById('inputText').value).codes,prefix=document.getElementById('headingSelect').value;
  const markdown=codes.length?S.lines(codes,gameKey(),prefix).map(r=>r.content).join('\n'):'';
  return {game:S.GAMES[gameKey()]?.name,gameKey:gameKey(),baseUrl:currentBaseUrl,codes,prefix,markdown};
}

async function copyUrls(btn) {
  const snapshot = getOutputSnapshot();
  if (!snapshot.codes.length) return;
  if (!await copyToClipboard(snapshot.codes.map(c=>snapshot.baseUrl+encodeURIComponent(c)).join('\n'))) return showToast('コピーに失敗しました', 'err');
  saveHistory(snapshot.markdown,snapshot.codes,snapshot);
  copyFeedback(btn);
}
function copyFeedback(btn) {
  if (!btn) return;
  if (btn.dataset.state === 'copied') return;
  const original = btn.innerHTML;
  const originalLabel = btn.getAttribute('aria-label');
  btn.dataset.state = 'copied';
  btn.innerHTML = `${iconSvg('check')}${btn.classList.contains('code-action') ? '<span class="sr-only">コピーしました</span>' : '<span>コピーしました</span>'}`;
  btn.setAttribute('aria-label','コピーしました');
  setTimeout(()=>{if (btn.isConnected) {btn.innerHTML=original;delete btn.dataset.state;if(originalLabel)btn.setAttribute('aria-label',originalLabel);else btn.removeAttribute('aria-label');}},2200);
}
function updateSendState() {
  const targets=targetsForGame(),btn=document.getElementById('sendBtn');if(!btn)return;
  const codes=analyzeCodes(document.getElementById('inputText').value).codes;
  const posts=codes.length?S.messages(codes,gameKey(),document.getElementById('headingSelect').value).length*targets.length:0;
  const left=delivery.remaining('normal',targets.map(targetKey));
  btn.disabled=sendBusy||!targets.length||left>0||!codes.length||targets.length>L.targets||posts>L.messages;
  btn.innerHTML=sendBusy?'<div class="spin"></div><span>送信中…</span>':`${iconSvg('send')}<span>${left?`あと${Math.ceil(left/1000)}秒`:'Discordへ送信'}</span>`;
  const hint=document.getElementById('sendHint');
  const label=targets.length?`${S.GAMES[gameKey()]?.short||''} · ${targets.length} / 5送信先${codes.length?` · ${posts}投稿`:''}`:`${S.GAMES[gameKey()]?.short||'このゲーム'}の送信先がありません`;
  const warning=targets.length>L.targets?'送信先を5件以下にしてください。':posts>L.messages?'合計10投稿以内になるよう送信先やコードを減らしてください。':'';
  const markup=`<span>${esc(warning||label)}</span><button type="button" data-action="settings">${targets.length?'送信先を変更':'送信先を設定'}</button>`;
  if(hint.dataset.signature!==markup){hint.innerHTML=markup;hint.dataset.signature=markup;}
  hint.classList.toggle('limit-warning',!!warning);

  for(const control of document.querySelectorAll('#tab-settings input,#tab-settings button,#tab-settings select')) {
    if(control.closest('.settings-modes'))continue;
    if(sendBusy){if(control.dataset.busyDisabled===undefined)control.dataset.busyDisabled=String(control.disabled);control.disabled=true;}
    else if(control.dataset.busyDisabled!==undefined){control.disabled=control.dataset.busyDisabled==='true';delete control.dataset.busyDisabled;}
  }
  if(!sendBusy)for(const button of document.querySelectorAll('[data-action="test"]')){
    const w=webhooks.find(w=>w.id===Number(button.dataset.id)),left=w?.url?delivery.remaining('test',[targetKey(w)]):0;
    const stopped=w?.url&&delivery.rate.dead[targetKey(w)]>delivery.now();
    button.disabled=!w?.url||left>0;
    button.textContent=stopped?'URL要確認':left?`あと${Math.ceil(left/1000)}秒`:'テスト送信';
    button.title=stopped?'DiscordでURL・権限を確認し、URLを再設定してください。':'';
  }
  updateRetryButton();
}
function bindControls() {

  const actions={normalize:normalizeInput,undoInput,storageSettings:()=>{switchTab('settings',null);setSettingsView('data');},converterView:el=>setConverterView(el.dataset.view),settingsView:el=>setSettingsView(el.dataset.view),newWebhook:()=>{setSettingsView('add');document.getElementById('webhookGame').focus({preventScroll:true});},results:()=>{setConverterView('result');document.getElementById('step-output').focus({preventScroll:true});},settings:()=>{setSettingsView('list');switchTab('settings',null);},tab:el=>switchTab(el.dataset.tab,el),help:el=>openHelp(el.dataset.anchor),view:el=>setResultView(el.dataset.view),paste:pasteCodes,clear:()=>clearField('inputText'),copy:copyText,urls:copyUrls,send:sendToDiscord,link:copyLinkValue,add:addWebhook,eye:el=>togglePw(el.dataset.field,el),allOn:()=>toggleAll(true),allOff:()=>toggleAll(false),export:()=>exportWebhooks(false),backup:()=>exportWebhooks(true),import:()=>document.getElementById('importFile').click(),clearAll:clearAllData,clearHistory,clearLog,retry:retryFailedWebhooks,close:closeModal,test:el=>testWebhook(Number(el.dataset.id)),deleteWebhook:el=>deleteWebhook(Number(el.dataset.id)),restore:el=>restoreHistory(Number(el.dataset.id)),deleteHistory:el=>deleteHistory(Number(el.dataset.id))};
  document.addEventListener('click',e=>{
    const openLink=e.target.closest('a.code-open[data-open-code]');
    if(openLink){
      openedCodes.add(`${gameKey()}:${openLink.dataset.openCode}`);
      const row=openLink.closest('.code-row');
      if(row?.dataset)row.dataset.opened='true';
      return;
    }
    const el=e.target.closest('[data-action]');if(!el||el.disabled)return;const action=actions[el.dataset.action];if(action){e.preventDefault();Promise.resolve(action(el)).catch(()=>showToast('操作を完了できませんでした。','err'));}
  });
  document.addEventListener('change',e=>{const el=e.target;
    if(el.matches('.game-radio'))onGameChange(el);
    else if(el.id==='headingSelect'){renderPreview();if(saveEnabled)storePreferences();}
    else if(el.id==='persistenceToggle')togglePersistence(el.checked);
    else if(el.id==='importFile')importWebhooks(e);
    else if(el.dataset.edit)updateWebhook(Number(el.dataset.id),el.dataset.edit,el.type==='checkbox'?el.checked:el.value);
  });
  document.getElementById('webhookForm').addEventListener('submit',e=>{e.preventDefault();addWebhook();});
  for(const id of ['webhookName','webhookUrl']){
    const field=document.getElementById(id);
    field.addEventListener('blur',e=>{if(e.relatedTarget?.closest('#webhookForm button'))return;if(e.target.value||e.target.hasAttribute('aria-invalid'))validateNewWebhookField(e.target);});
    field.addEventListener('input',e=>{if(e.target.hasAttribute('aria-invalid'))validateNewWebhookField(e.target);});
  }
  const syncLocation=()=>{const hash=location.hash.slice(1);switchTab(hash==='settings'?'settings':hash==='help'||hash.startsWith('help-')?'help':'converter',null,false);if(hash.startsWith('help-'))document.getElementById(hash)?.scrollIntoView({block:'start'});};
  window.addEventListener('popstate',syncLocation);window.addEventListener('hashchange',syncLocation);
  const input=document.getElementById('inputText');input.addEventListener('input',onCodesInput);
  input.addEventListener('paste',e=>{const text=e.clipboardData?.getData('text')||'';if(input.value.length-(input.selectionEnd-input.selectionStart)+text.length>L.inputChars){e.preventDefault();inputOverflow=true;renderPreview();showToast('10,000文字を超えるため貼り付けを中止しました。','err');}});
  window.addEventListener('storage',e=>{
    if(e.key===PREF_KEY){let pref;try{pref=JSON.parse(boundedRead(PREF_KEY)||'{}');}catch{return;}
      if(pref.saveEnabled===false&&saveEnabled){saveEnabled=false;delivery.forgetSent();histories=[];document.getElementById('persistenceToggle').checked=false;renderHistories();updateStorageModeUI();closeModal();}
    }
    if(e.key===STORAGE_KEY&&saveEnabled&&!sendBusy){loadWebhooks();closeModal();}
    updateSendState();
  });
}

let storageWarningShown=false;
function storageWrite(key,value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch {
    storageWarning();
    return false;
  }
}
function storageRemove(key) {
  try {localStorage.removeItem(key);return true;}
  catch {showToast('保存データを削除できませんでした。ブラウザのサイトデータ設定を確認してください。','err');return false;}
}
function nextWebhookId() { return Math.max(Date.now(),...webhooks.map(w=>w.id+1)); }

function storageWarning(){if(!storageWarningShown){storageWarningShown=true;showToast('ブラウザに保存できません。設定の保持と複数タブの制限に影響します。','warn');}}

/* Viewport workspace: pages stay fixed, long content has a local scroll area. */
const compactWorkspace=matchMedia('(max-width: 62rem), (max-height: 36rem)');
function syncWorkspace() {
  const converter=document.getElementById('tab-converter');
  const view=converter.dataset.workspace||'input';
  const isHistory=view==='history';
  document.querySelector('.converter-workbench').hidden=isHistory;
  document.getElementById('historyPanel').hidden=!isHistory;
  document.querySelector('.input-panel').hidden=isHistory||(compactWorkspace.matches&&view==='result');
  document.getElementById('outputPanel').hidden=isHistory||(compactWorkspace.matches&&view==='input');
  for(const button of document.querySelectorAll('.converter-modes button'))button.setAttribute('aria-pressed',String(button.dataset.view===view));
  document.querySelector('.history-mode-label').textContent=isHistory&&!compactWorkspace.matches?'作成に戻る':'履歴';
  const settings=document.getElementById('tab-settings').dataset.workspace||'list';
  for(const [key,selector]of Object.entries({list:'.destinations-panel',add:'.add-panel',log:'.log-panel',data:'.data-panel'}))document.querySelector(selector).hidden=key!==settings;
  for(const button of document.querySelectorAll('.settings-modes button'))button.setAttribute('aria-pressed',String(button.dataset.view===settings));
  const viewport=window.visualViewport;
  document.documentElement.style.setProperty('--app-height',`${viewport?.height||innerHeight}px`);
  const nav=document.querySelector('.nav-tabs');
  nav.setAttribute('aria-orientation',getComputedStyle(nav).flexDirection==='column'?'vertical':'horizontal');
  document.documentElement.style.setProperty('--bottom-nav-height',getComputedStyle(nav).position==='fixed'?`${nav.getBoundingClientRect().height}px`:'0px');
}
function setConverterView(view) {
  if(!['input','result','history'].includes(view))return;
  const pane=document.getElementById('tab-converter');
  if(view==='history'&&pane.dataset.workspace==='history'&&!compactWorkspace.matches)view='input';
  pane.dataset.workspace=view;syncWorkspace();
  if(view==='input')document.getElementById('inputText').focus({preventScroll:true});
  else if(view==='result')(document.getElementById('step-output').getClientRects().length?document.getElementById('step-output'):document.getElementById('outputPanel')).focus({preventScroll:true});
  else document.getElementById('historyList').focus({preventScroll:true});
}
function setSettingsView(view) {
  if(!['list','add','log','data'].includes(view))return;
  document.getElementById('tab-settings').dataset.workspace=view;syncWorkspace();
  // If switching hid the active field, focus the visible navigation control.
  if(document.activeElement?.closest('[hidden]'))document.querySelector(`.settings-modes [data-view="${view}"]`)?.focus({preventScroll:true});
}
function setupWorkspace() {
  syncWorkspace();
  compactWorkspace.addEventListener('change',syncWorkspace);
  window.addEventListener('resize',syncWorkspace);
  window.visualViewport?.addEventListener('resize',syncWorkspace);
  new ResizeObserver(syncWorkspace).observe(document.querySelector('.nav-tabs'));
}
