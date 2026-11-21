import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { toZhCN } from '../src/admin-v2/i18n-zh-cn.js';

const appJsPath = new URL('../src/admin-v2/app.js', import.meta.url);
const gatewayAppPath = new URL('../src/gateway/app.mjs', import.meta.url);
const dockerfilePath = new URL('../Dockerfile', import.meta.url);

const appSource = await readFile(appJsPath, 'utf8');

function extractChineseStrings(source) {
  const strRe = /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g;
  const out = [];
  for (const match of source.matchAll(strRe)) {
    const raw = match[0];
    if (/[\u3400-\u9FFF]/.test(raw)) {
      out.push(raw.slice(1, -1));
    }
  }
  return out;
}

test('toZhCN converts key HK/TW technical and UI terminology to idiomatic zh-CN', () => {
  const cases = [
    ['閘道', '网关'],
    ['帳戶', '账号'],
    ['API 金鑰', 'API 密钥'],
    ['工作階段與故障轉移', '会话与故障转移'],
    ['登入階段已過期，請重新登入。', '登录会话已过期，请重新登录。'],
    ['匯出中繼資料', '导出元数据'],
    ['私隱優先：此畫面及匯出不包含提示詞、回覆、工具參數、憑證或 OAuth 連結。', '隐私优先：此画面及导出不包含提示词、回复、工具参数、凭证或 OAuth 链接。'],
    ['無法連接管理 API，請檢查閘道連線並重試。', '无法连接管理 API，请检查网关连接并重试。'],
    ['重新整理', '刷新'],
    ['設定', '设置'],
    ['已儲存變更。', '已保存更改。'],
    ['已複製到剪貼簿。', '已复制到剪贴板。'],
    ['登出', '退出登录'],
    ['非串流', '非流式'],
    ['持久化 SQLite 審計日誌。檢視提示詞、回覆、工具呼叫、延遲與錯誤。', '持久化 SQLite 审计日志。查看提示词、回复、工具调用、延迟与错误。'],
    ['暫無紀錄', '暂无记录'],
    ['快速帳戶篩選', '快速账号筛选'],
    ['工具呼叫採用已披露的提示詞協議，並非原生結構化函數呼叫。', '工具调用采用已披露的提示词协议，并非原生结构化函数调用。'],
    ['額度更新時間唔代表一定補滿。', '额度更新时间不代表一定会补满。'],
    ['上游拒絕咗此請求。呢個紀錄唔會喺本機封鎖之後嘅請求，亦唔需要重試名額；只有之後完整驗證嘅回應先能驗證存取。', '上游拒绝了此请求。该记录不会在本地封锁后续请求，也不需要重试配额；只有后续完整验证的响应才能验证访问权限。'],
  ];

  for (const [input, expected] of cases) {
    assert.equal(toZhCN(input), expected, `Failed converting: ${input}`);
  }
});

test('toZhCN eliminates all Cantonese particles and Traditional characters across every Chinese string in src/admin-v2/app.js', () => {
  const zhStrings = extractChineseStrings(appSource);
  assert.ok(zhStrings.length > 500, `Expected >500 Chinese strings in app.js, found ${zhStrings.length}`);

  const forbiddenCantonese = /[嘅唔喺咗呢]/;
  const forbiddenTraditional = /[閘帳鑰檢視設儲匯複憑錄篩審誌應請錯誤連線啟資訊並來個傳僅優內兩別刪則動務區協卻參員問單嘗圍圖執報塊實寫將專尋對導屜層屬庫後徑從復態憶戶捨採換摺擇擊據擬敗數斷於時暫會條棄構標樣機檔欄權歡歷沒測湊準滿瀏為無營狀獨環產畫異當疊發盡監確碼稱穩筆範簽籤紀約純級細終組結絕絡統綁網綴緒緩總繼續義聯脈與舊薦處衝補裡製見規覽觀訂計託記許診詞詢試話詳認語說證識議護讀變費貼蹤軟較載輪輸轉這週進運過達遠適遲選還郵銷錯鎖鐘閉開間閱關階際隨隱雙雜離電響頁項須預題額類顯餘驗驟體鮮點]/;

  const residual = [];
  for (const raw of zhStrings) {
    // Skip the language toggle label itself ('繁中') which intentionally names Traditional Chinese.
    if (raw === '繁中') continue;
    const converted = toZhCN(raw);
    if (forbiddenCantonese.test(converted) || forbiddenTraditional.test(converted)) {
      residual.push({ raw, converted });
    }
  }

  assert.deepEqual(residual, [], `Found residual Cantonese/Traditional chars in converted strings: ${JSON.stringify(residual.slice(0, 10), null, 2)}`);
});

function loadAppFixture({ savedLang = null, navLang = 'en-US' } = {}) {
  const storage = new Map();
  if (savedLang !== null) storage.set('gemini_lang', savedLang);
  class StubNode {
    constructor(id = '') { this.id = id; this.dataset = {}; this.style = {}; this.children = []; this.attrs = {}; this.listeners = {}; }
    addEventListener(evt, fn) { this.listeners[evt] = fn; }
    setAttribute(k, v) { this.attrs[k] = v; }
    removeAttribute(k) { delete this.attrs[k]; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = [...nodes]; }
    contains() { return false; }
    focus() {}
    blur() {}
    close() {}
    showModal() {}
    getClientRects() { return []; }
    scrollIntoView() {}
  }
  const nodesById = new Map();
  const sandbox = {
    URL, URLSearchParams, Intl, Date, Number, Object, Array, JSON, String, Boolean, Blob,
    setTimeout, clearTimeout, setInterval, clearInterval, AbortController, DOMException,
    Node: StubNode, CSS: { escape: v => String(v) },
    navigator: { language: navLang },
    location: { search: '?demo=1', hash: '', href: 'http://fixture.invalid/admin/?demo=1', origin: 'http://fixture.invalid', protocol: 'http:' },
    history: { replaceState() {} },
    document: {
      hidden: false, activeElement: null, documentElement: { dataset: {}, lang: 'en' }, title: '',
      addEventListener() {},
      getElementById: id => { if (!nodesById.has(id)) nodesById.set(id, new StubNode(id)); return nodesById.get(id); },
      querySelector: () => null, querySelectorAll: () => [],
      createElement: tag => new StubNode(tag), createElementNS: () => new StubNode(),
      createTextNode: text => String(text),
    },
    window: { addEventListener() {} },
    localStorage: {
      getItem: k => storage.has(k) ? storage.get(k) : null,
      setItem: (k, v) => storage.set(k, String(v)),
    },
    fetch: () => { throw new Error('Unexpected fetch'); },
    toZhCN,
  };
  const context = vm.createContext(sandbox);
  const runnable = appSource
    .replace(/^import\s+\{[^}]*\}\s+from\s+['"][^'"]+['"];?\s*\n/m, '')
    .replace(/\nboot\(\);\s*$/, '\n');
  vm.runInContext(
    runnable + '\nglobalThis.subject = { S, L, I18N, t, preferenceControls, applyPreferences };',
    context,
    { timeout: 2000 },
  );
  return { ...sandbox.subject, storage, document: sandbox.document };
}

test('app.js supports zh-CN auto-detection, preserves saved preferences, and cycles en -> zh-CN -> zh-HK -> en', () => {
  const autoCn = loadAppFixture({ savedLang: null, navLang: 'zh-CN' });
  assert.equal(autoCn.S.lang, 'zh-CN');
  assert.equal(autoCn.t('accounts'), '账号');
  assert.equal(autoCn.t('audits'), '审计日志');
  assert.equal(autoCn.L('Gateway', '閘道'), '网关');

  const savedHk = loadAppFixture({ savedLang: 'zh-HK', navLang: 'zh-CN' });
  assert.equal(savedHk.S.lang, 'zh-HK');
  assert.equal(savedHk.t('accounts'), '帳戶');

  const savedEn = loadAppFixture({ savedLang: 'en', navLang: 'zh-CN' });
  assert.equal(savedEn.S.lang, 'en');
  assert.equal(savedEn.t('accounts'), 'Accounts');

  // Cycle: en -> zh-CN -> zh-HK -> en
  const [btn1] = savedEn.preferenceControls();
  assert.equal(btn1.attrs.id, 'language-toggle');
  assert.equal(btn1.children[0], '简中');
  btn1.listeners.click();
  assert.equal(savedEn.S.lang, 'zh-CN');
  assert.equal(savedEn.storage.get('gemini_lang'), 'zh-CN');

  const [btn2] = savedEn.preferenceControls();
  assert.equal(btn2.children[0], '繁中');
  btn2.listeners.click();
  assert.equal(savedEn.S.lang, 'zh-HK');
  assert.equal(savedEn.storage.get('gemini_lang'), 'zh-HK');

  const [btn3] = savedEn.preferenceControls();
  assert.equal(btn3.children[0], 'English');
  btn3.listeners.click();
  assert.equal(savedEn.S.lang, 'en');
  assert.equal(savedEn.storage.get('gemini_lang'), 'en');
});

test('gateway app.mjs serves /admin/i18n-zh-cn.js as application/javascript and Dockerfile copies it', async () => {
  const gatewaySrc = await readFile(gatewayAppPath, 'utf8');
  assert.match(gatewaySrc, /\["\/admin\/i18n-zh-cn\.js",\s*"i18n-zh-cn\.js"\]/);
  assert.match(gatewaySrc, /application\/javascript;\s*charset=utf-8/);

  const dockerfile = await readFile(dockerfilePath, 'utf8');
  assert.match(dockerfile, /src\/admin-v2\/i18n-zh-cn\.js/);
});
