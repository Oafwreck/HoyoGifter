"""Static HTML/CSS contracts only. This does not launch or emulate a browser."""
from pathlib import Path
from html.parser import HTMLParser
import json, os
from datetime import datetime, timezone

root=Path(__file__).resolve().parents[1]
dist=root
class Markup(HTMLParser):
    void={'area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr'}
    def __init__(self):super().__init__();self.nodes=[];self.stack=[];self.errors=[]
    def handle_starttag(self,tag,attrs):
        node={'tag':tag,'attrs':dict(attrs),'parents':list(self.stack)}
        self.nodes.append(node)
        if len(attrs)!=len(node['attrs']):self.errors.append('Duplicate attribute: '+tag)
        if tag not in self.void:self.stack.append(node)
    def handle_endtag(self,tag):
        if not self.stack or self.stack[-1]['tag']!=tag:self.errors.append('Unbalanced closing tag: '+tag)
        else:self.stack.pop()
    def handle_startendtag(self,tag,attrs):
        self.handle_starttag(tag,attrs)
        if tag not in self.void:self.handle_endtag(tag)
p=Markup();p.feed((dist/'index.html').read_text(encoding='utf-8'))
checks=[]
def test(name,fn):
    try:fn();checks.append({'name':name,'status':'pass'})
    except Exception as e:checks.append({'name':name,'status':'fail','detail':str(e)})
def require(value,reason):
    if not value:raise AssertionError(reason)
ids=[n['attrs']['id'] for n in p.nodes if 'id' in n['attrs']]
test('HTMLの入れ子と属性の整合',lambda:require(not p.errors and not p.stack,str(p.errors)))
test('IDの重複なし',lambda:require(len(ids)==len(set(ids)),'duplicate id'))
def references():
    for n in p.nodes:
        for key in ['aria-controls','aria-labelledby','aria-describedby','for']:
            for value in (n['attrs'].get(key) or '').split():require(value in ids,key+' -> '+value)
test('ラベル・ARIA参照先が存在',references)
def assets():
    for n in p.nodes:
        a=n['attrs'];value=a.get('src') if n['tag']=='script' else a.get('href') if n['tag']=='link' else None
        if value:
            target=(dist/value).resolve();require(target.is_relative_to(dist.resolve()) and target.is_file(),str(value))
test('実行スクリプトとCSSがローカル成果物に存在',assets)
def actions():
    js=(dist/'js/app.js').read_text(encoding='utf-8');mapped=js.split('const actions={',1)[1].split('};',1)[0]
    for n in p.nodes:
        action=n['attrs'].get('data-action')
        if action:require(action in mapped,'Unbound action: '+action)
test('全UIアクションが既存ディスパッチャに接続',actions)
def data_actions():
    for action in ['export','backup','import']:
        nodes=[n for n in p.nodes if n['attrs'].get('data-action')==action];require(len(nodes)==1,action)
        require(any('data-panel' in x['attrs'].get('class','').split() for x in nodes[0]['parents']),action+' outside data view')
test('書き出し・秘密バックアップ・読み込みをデータ画面へ集約',data_actions)
def input_controls():
    for id in ['normalizeInputBtn','undoInputBtn','storageStatusBtn']:
        n=next(n for n in p.nodes if n['attrs'].get('id')==id)
        require(n['tag']=='button' and n['attrs'].get('type')=='button' and n['attrs'].get('aria-label'),id)
    require(next(n for n in p.nodes if n['attrs'].get('id')=='inputText')['attrs'].get('maxlength')=='10000','input limit')
test('追加操作はラベル付きボタン、入力上限を維持',input_controls)
def privacy():
    for n in p.nodes:
        require(not any(k.startswith('on') for k in n['attrs']),'inline event handler')
    csp=next(n['attrs']['content'] for n in p.nodes if n['attrs'].get('http-equiv')=='Content-Security-Policy')
    require("connect-src https://discord.com;" in csp,'CSP changed')
    require(next(n for n in p.nodes if n['attrs'].get('id')=='webhookUrl')['attrs'].get('type')=='password','secret visible')
test('CSP・秘密URLの非表示・インラインイベント禁止を維持',privacy)
def css_contract():
    css=(dist/'css/workspace.css').read_text(encoding='utf-8')
    require(css.count('{')==css.count('}'),'unbalanced CSS')
    require('body:not([data-page="help"])' in css and '--app-height' in css,'fixed shell lost')
    require('overflow:auto' in css and '.data-panel' in css,'local scroll areas lost')
test('固定画面・内部スクロールのCSS宣言を維持（描画は未検証）',css_contract)
def task_structure():
    for id in ['step-game','step-code','step-output']:
        n=next(n for n in p.nodes if n['attrs'].get('id')==id)
        require(n['tag']=='h2','task heading: '+id)
        require(any('task-index' in child['attrs'].get('class','').split() and n in child['parents'] for child in p.nodes),'task order: '+id)
test('作品選択・入力・共有を順序付きの見出しで案内',task_structure)
def named_tools():
    for action in ['paste','normalize','undoInput','clear']:
        n=next(n for n in p.nodes if n['attrs'].get('data-action')==action)
        require(any('action-label' in child['attrs'].get('class','').split() and n in child['parents'] for child in p.nodes),'visible action name: '+action)
test('入力ツールの全操作に見える文字ラベルを用意',named_tools)
def shell_navigation():
    n=next(n for n in p.nodes if 'nav-tabs' in n['attrs'].get('class','').split())
    require(n['attrs'].get('aria-orientation') in ['vertical','horizontal'],'nav orientation')
    require(any('sidebar-support' in parent['attrs'].get('class','').split() for node in p.nodes if node['attrs'].get('id')=='storageStatusBtn' for parent in node['parents']),'storage section')
test('ナビゲーションと保存管理の場所・意味を明示',shell_navigation)
result={'testedAt':datetime.now(timezone.utc).isoformat(),'environment':'Python HTMLParser / static source contracts; no browser','checks':checks}
if os.environ.get('HOYO_MARKUP_REPORT'):Path(os.environ['HOYO_MARKUP_REPORT']).write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'passed':sum(c['status']=='pass' for c in checks),'failed':[c for c in checks if c['status']=='fail']},ensure_ascii=True))
raise SystemExit(1 if any(c['status']=='fail' for c in checks) else 0)
