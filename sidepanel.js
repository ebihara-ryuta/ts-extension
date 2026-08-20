/* ============================================================
   Obsidian -> TeamSpirit 工数入力アシスタント
   sidepanel.js
   ============================================================ */

/* ---------- IndexedDB: ディレクトリハンドルの保存 ---------- */

const DB_NAME = "ts-assistant";
const STORE_NAME = "handles";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

/* ---------- Vault フォルダ選択 & ファイル読み込み ---------- */

let vaultHandle = null;

async function pickVault() {
  const handle = await window.showDirectoryPicker();
  await idbSet("vaultHandle", handle);
  vaultHandle = handle;
  return handle;
}

async function restoreVault() {
  const handle = await idbGet("vaultHandle");
  if (!handle) return null;
  try {
    const perm = await handle.requestPermission({ mode: "read" });
    if (perm !== "granted") return null;
    vaultHandle = handle;
    return handle;
  } catch (e) {
    return null;
  }
}

// dateStr: "YYYY-MM-DD" -> ファイル名 "YYYY-MM-DD.md" をVault内で再帰的に探す
async function findAndReadNote(dirHandle, filename, depth = 0) {
  if (depth > 6) return null;
  // まずカレント階層を見る
  try {
    const fileHandle = await dirHandle.getFileHandle(filename);
    const file = await fileHandle.getFile();
    return await file.text();
  } catch (e) {
    // 見つからなければサブフォルダを探索
  }
  for await (const [name, entry] of dirHandle.entries()) {
    if (entry.kind === "directory") {
      const result = await findAndReadNote(entry, filename, depth + 1);
      if (result !== null) return result;
    }
  }
  return null;
}

/* ---------- デイリーノートのパーサー(固定フォーマット) ---------- */
//
// 対応フォーマット:
//
//   ## 工数            (見出しレベルは # 〜 ###### のどれでもOK)
//   - キーワードまたはジョブコード：H:MM        (時間を直接指定)
//   - キーワードまたはジョブコード：残り時間すべて (％モードに切替のみ。残りの
//                                              時間を全てそのジョブに当てはめる、値は入力しない)
//
// 区切り文字は全角「：」に固定。時刻表記(H:MM)側は半角「:」を使うため、
// 項目と値の区切り(全角：)と時刻の区切り(半角:)を明確に分けて混同を避けている。
//
// 「工数」という見出し(#の数はいくつでもよい)の直後から、次の見出し行が
// 現れるまでを工数セクションとして扱う。セクション内で
// "- テキスト：H:MM" または "- テキスト：残り時間すべて" の形の行だけを
// 厳密に読み取る。それ以外の書式(自然文・時間表記の揺れなど)は対象外。

const SECTION_HEADER_RE = /^#{1,6}\s*工数\s*$/;
const ANY_HEADER_RE = /^#{1,6}\s/;
const ENTRY_TIME_RE = /^[-*]\s*(.+?)\s*：\s*(\d{1,2}):([0-5]\d)\s*$/;
const ENTRY_PERCENT_RE = /^[-*]\s*(.+?)\s*：\s*残り時間すべて\s*$/;

function parseNote(text) {
  const lines = text.split(/\r?\n/);
  const items = [];
  let inSection = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (SECTION_HEADER_RE.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && ANY_HEADER_RE.test(line)) {
      // 工数セクション終了(次の見出しに到達)
      inSection = false;
      continue;
    }
    if (!inSection) continue;

    const timeMatch = line.match(ENTRY_TIME_RE);
    if (timeMatch) {
      const description = timeMatch[1].trim();
      const hours = parseInt(timeMatch[2], 10) + parseInt(timeMatch[3], 10) / 60;
      items.push({
        raw: line,
        description,
        mode: "time",
        hours: Math.round(hours * 100) / 100,
      });
      continue;
    }

    const percentMatch = line.match(ENTRY_PERCENT_RE);
    if (percentMatch) {
      const description = percentMatch[1].trim();
      items.push({
        raw: line,
        description,
        mode: "percent",
        hours: null,
      });
      continue;
    }
    // 形式に合わない行は無視
  }
  return items;
}

/* ---------- 「やったこと」セクションの抽出 ---------- */
//
// 「工数」と同様に、「やったこと」という見出し(#の数はいくつでもよい)の
// 直後から次の見出し行が現れるまでの内容を、そのままのテキストとして抜き出す。
// (時間や案件へのマッチングは行わない。作業報告の冒頭に転記するための
// 素材として使う)

function extractHeadingSection(text, headingText) {
  const escaped = headingText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headerRe = new RegExp(`^#{1,6}\\s*${escaped}\\s*$`);
  const lines = text.split(/\r?\n/);
  let collecting = false;
  const collected = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (headerRe.test(line)) {
      collecting = true;
      continue;
    }
    if (collecting && ANY_HEADER_RE.test(line)) {
      collecting = false;
      continue;
    }
    if (collecting) collected.push(raw);
  }

  // 前後の空行を除去
  while (collected.length && collected[0].trim() === "") collected.shift();
  while (collected.length && collected[collected.length - 1].trim() === "") collected.pop();

  return collected.join("\n");
}

/* ---------- TeamSpiritページとのやり取り(scripting API) ---------- */

// ページ内で実行する関数: 工数実績入力ダイアログの行から案件一覧を取得
// コードは隠しinputから(表記ゆれが無い)、名前は画面に表示されているdivの
// テキストから取得する(隠しinputの値は大文字化されている場合があるため)。
function scrapeJobsInPage() {
  const rows = document.querySelectorAll("#empWorkTableBody > tr");
  const jobs = [];
  rows.forEach((row, index) => {
    const hiddenInputs = row.querySelectorAll('input[type="hidden"]');
    let codeName = null;
    hiddenInputs.forEach((inp) => {
      if (inp.value && inp.value.includes("|")) codeName = inp.value;
    });
    if (!codeName) return;
    const pipeIdx = codeName.indexOf("|");
    const code = codeName.slice(0, pipeIdx);
    let name = codeName.slice(pipeIdx + 1); // フォールバック(隠しinputの値)

    // 表示用divから名前を取得できれば、それを優先する
    const outerNameDiv = row.querySelector("td > div.name");
    if (outerNameDiv) {
      const innerNameDivs = Array.from(outerNameDiv.children).filter((el) =>
        el.classList.contains("name")
      );
      if (innerNameDivs.length >= 2) {
        name = innerNameDivs[1].textContent.trim();
      } else if (innerNameDivs.length === 1) {
        name = innerNameDivs[0].textContent.trim();
      }
    }

    jobs.push({ index, code, name });
  });
  return jobs;
}

// ページ内で実行する関数: 指定した行に時間を入力する
// entries: [{ index, hoursDecimal }]
// TeamSpirit側がテーブルを裏で再描画するタイミングと重なると、要素が
// 一瞬見つからないことがあるため、見つからない場合は複数回リトライする。
async function fillEntriesInPage(entries) {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const MAX_ATTEMPTS = 2;
  const RETRY_INTERVAL_MS = 150;
  const results = [];

  for (const { index, hoursDecimal } of entries) {
    try {
      let clockLabel, clockRadio, input;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        clockLabel = document.getElementById(`btnClock2Label${index}`);
        clockRadio = document.getElementById(`btnClock2${index}`);
        input = document.getElementById(`empInputTime${index}`);
        if ((clockLabel || clockRadio) && input) break;
        await wait(RETRY_INTERVAL_MS);
      }

      if (clockLabel) clockLabel.click();
      else if (clockRadio) clockRadio.click();

      // クリック直後に input が入れ替わるケースに備えて取得し直す
      input = document.getElementById(`empInputTime${index}`);
      if (!input) {
        results.push({ index, ok: false, reason: "empInputTime input not found" });
        continue;
      }
      const h = Math.floor(hoursDecimal);
      const m = Math.round((hoursDecimal - h) * 60);
      const timeStr = `${h}:${String(m).padStart(2, "0")}`;

      input.value = timeStr;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new Event("blur", { bubbles: true }));

      results.push({ index, ok: true, timeStr });
    } catch (e) {
      results.push({ index, ok: false, reason: String(e) });
    }
  }
  return results;
}

// ページ内で実行する関数: 指定した行を「％(パーセント)モード」に切り替え、
// スライダーを1目盛り動かす(TeamSpiritの「残りの時間を全て当てはめる」動きを
// 起こすための操作)。dijitウィジェットのAPI(registry.byId().set('value', ...))を
// 直接呼ぶ、1パターンのみの実装。
// TeamSpirit側がテーブルを裏で再描画するタイミングと重なると、要素が
// 一瞬見つからないことがあるため、見つからない場合は複数回リトライする。
// indexes: [rowIndex, ...]
async function setPercentModeInPage(indexes) {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const MAX_ATTEMPTS = 2;
  const RETRY_INTERVAL_MS = 150;
  const results = [];

  for (const index of indexes) {
    try {
      // 1) ％モードに切り替える
      let percentLabel, percentRadio;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        percentLabel = document.getElementById(`btnPercentLabel${index}`);
        percentRadio = document.getElementById(`btnPercent${index}`);
        if (percentLabel || percentRadio) break;
        await wait(RETRY_INTERVAL_MS);
      }

      if (percentLabel) percentLabel.click();
      else if (percentRadio) percentRadio.click();
      else {
        results.push({ index, ok: false, reason: "btnPercentLabel/btnPercent not found" });
        continue;
      }

      // 2) dijitウィジェットのAPIを直接呼んで、スライダーを1目盛り動かす
      const registry = window.dijit && window.dijit.registry;
      if (!registry || typeof registry.byId !== "function") {
        results.push({ index, ok: false, reason: "window.dijit.registry not available" });
        continue;
      }
      let widget;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        widget = registry.byId(`empWorkSlider${index}`);
        if (widget) break;
        await wait(RETRY_INTERVAL_MS);
      }
      if (!widget || typeof widget.set !== "function") {
        results.push({ index, ok: false, reason: "dijit widget(empWorkSlider) not found" });
        continue;
      }
      const current = typeof widget.get === "function" ? Number(widget.get("value")) : Number(widget.value) || 0;
      widget.set("value", current + 1);

      results.push({ index, ok: true });
    } catch (e) {
      results.push({ index, ok: false, reason: String(e) });
    }
  }
  return results;
}

// ページ内で実行する関数: 「作業報告」自由入力欄に個別の内容を転記する
function setWorkReportInPage(text) {
  const textarea = document.getElementById("empWorkTableNote");
  if (!textarea) return { ok: false, reason: "empWorkTableNote が見つかりません" };
  textarea.value = text;
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  textarea.dispatchEvent(new Event("change", { bubbles: true }));
  textarea.dispatchEvent(new Event("blur", { bubbles: true }));
  return { ok: true };
}

// TeamSpirit/Salesforceらしきホスト名かどうかを判定
// (manifest.jsonのhost_permissionsと同じドメインパターンに合わせて調整すること)
function isKnownHost(url) {
  if (!url) return false;
  try {
    const hostname = new URL(url).hostname;
    return /(\.|^)teamspirit\.com$|(\.|^)force\.com$|(\.|^)salesforce\.com$/.test(hostname);
  } catch (e) {
    return false;
  }
}

// 拡張機能ウィンドウが開いているウィンドウのアクティブタブだけでなく、
// 「Chromeアプリ化(PWAとして独立ウィンドウで開いた)」TeamSpiritタブも含めて
// 全ウィンドウから対象タブを探す。
async function findTeamSpiritTab() {
  // まずは拡張機能ウィンドウと同じウィンドウのアクティブタブを試す(一番よくあるケース)
  const [current] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (current && isKnownHost(current.url)) return current;

  // 見つからなければ、全ウィンドウ(アプリ化した独立ウィンドウも含む)を横断して探す
  const allTabs = await chrome.tabs.query({});
  const candidates = allTabs.filter((t) => isKnownHost(t.url));
  if (candidates.length === 0) return current || null;

  // 複数見つかった場合は、フォーカスされているタブを優先
  candidates.sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0));
  return candidates[0];
}

// 「工数実績入力」ダイアログの本体(#empWorkTableBody)を実際に持っているか、
// かつ dijit(Dojoウィジェット)のAPIが使えるかを判定する、ページ内で実行する
// 軽量チェック関数。同じ内容を持つフレームが複数存在し、一部だけ
// window.dijit へのアクセスが制限されている(Salesforceのセキュリティ機構など)
// ケースがあるため、両方の情報を返して呼び出し側で優先度を判断する。
function checkWorkDialogFrame() {
  return {
    hasTable: !!document.getElementById("empWorkTableBody"),
    hasDijit: !!(window.dijit && window.dijit.registry),
  };
}

// 全フレームに checkWorkDialogFrame を実行し、対象フレームの frameId を
// 特定する(推測ではなく事実確認)。
// 1) テーブルとdijitの両方を持つフレームを最優先
// 2) 無ければ、テーブルだけでも持っているフレームにフォールバック
// 見つからなければ null を返す。
async function findWorkDialogFrameId(tabId) {
  const injections = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: checkWorkDialogFrame,
    world: "MAIN",
  });
  const best = injections.find((inj) => inj.result && inj.result.hasTable && inj.result.hasDijit);
  if (best) return best.frameId;
  const fallback = injections.find((inj) => inj.result && inj.result.hasTable);
  return fallback ? fallback.frameId : null;
}

// state.workDialogFrameId に記録済みのframeIdを使い回す。無効になっていたら
// (ダイアログの再生成などで) 再検出する。以降の操作は特定した単一フレームだけを
// 対象に実行するので、「複数フレームのうちどれが正しいか推測する」必要が無い。
async function executeInWorkDialogFrame(func, args) {
  const tab = await findTeamSpiritTab();
  if (!tab) {
    throw new Error(
      "TeamSpiritのタブが見つかりません。TeamSpirit(アプリ化ウィンドウでも可)を開いた状態で再度お試しください。"
    );
  }

  let frameId = state.workDialogFrameId;

  // 記録済みのframeIdが今も有効(テーブル+dijitの両方を満たす)か確認する
  if (frameId != null) {
    try {
      const check = await chrome.scripting.executeScript({
        target: { tabId: tab.id, frameIds: [frameId] },
        func: checkWorkDialogFrame,
        world: "MAIN",
      });
      const r = check[0] && check[0].result;
      if (!r || !r.hasTable || !r.hasDijit) frameId = null;
    } catch (e) {
      frameId = null; // そのframeId自体が既に存在しない(タブ内で破棄された)場合
    }
  }

  // 無効 or 未検出なら、全フレームから実際のダイアログフレームを再検出する
  if (frameId == null) {
    frameId = await findWorkDialogFrameId(tab.id);
    if (frameId == null) {
      throw new Error(
        "TeamSpiritの「工数実績入力」ダイアログが見つかりません。ダイアログを開いた状態で再度お試しください。"
      );
    }
    state.workDialogFrameId = frameId;
  }

  const injections = await chrome.scripting.executeScript({
    target: { tabId: tab.id, frameIds: [frameId] },
    func,
    args: args || [],
    world: "MAIN",
  });
  return injections[0] ? injections[0].result : undefined;
}

/* ---------- エイリアス管理(ジョブコード → 複数キーワード) ---------- */

// aliasGroups: [{ jobCode: "PJ2000001933001", keywords: ["PMデイリー", "開発デイリー"] }, ...]
let aliasGroups = [];

async function loadAliases() {
  const data = await chrome.storage.local.get("aliasGroups");
  aliasGroups = Array.isArray(data.aliasGroups) ? data.aliasGroups : [];
}

async function saveAliases() {
  await chrome.storage.local.set({ aliasGroups });
}

// キーワードの区切りは全角読点「、」のみ。カンマや改行では区切らない(固定ルール)。
function parseKeywordsText(text) {
  return text
    .split("、")
    .map((s) => s.trim())
    .filter(Boolean);
}

function renderAliasRows() {
  const container = el("aliasContainer");
  container.innerHTML = "";
  aliasGroups.forEach((g, i) => {
    const row = document.createElement("div");
    row.className = "alias-row";
    const job = state.jobs.find((j) => j.code === g.jobCode);
    row.innerHTML = `
      <input class="code" data-i="${i}" list="jobCodeOptions" placeholder="ジョブコード" value="${escapeHtml(g.jobCode)}">
      <input class="kw" data-i="${i}" placeholder="キーワード(全角読点「、」で区切って複数入力可) 例: PMデイリー、開発デイリー" value="${escapeHtml((g.keywords || []).join("、"))}">
      <span class="alias-name">${job ? escapeHtml(job.name) : (g.jobCode ? "（現在のダイアログに見当たりません）" : "")}</span>
      <button class="del" data-i="${i}">削除</button>
    `;
    container.appendChild(row);
  });

  container.querySelectorAll("input.code").forEach((inp) =>
    inp.addEventListener("input", async (e) => {
      aliasGroups[+e.target.dataset.i].jobCode = e.target.value.trim();
      await saveAliases();
      renderAliasRows();
      rematchAndRender();
    })
  );
  container.querySelectorAll("input.kw").forEach((inp) =>
    inp.addEventListener("input", async (e) => {
      aliasGroups[+e.target.dataset.i].keywords = parseKeywordsText(e.target.value);
      await saveAliases();
      rematchAndRender();
    })
  );
  container.querySelectorAll("button.del").forEach((btn) =>
    btn.addEventListener("click", async (e) => {
      aliasGroups.splice(+e.target.dataset.i, 1);
      await saveAliases();
      renderAliasRows();
      rematchAndRender();
    })
  );
}

function renderJobCodeOptions() {
  const datalist = el("jobCodeOptions");
  datalist.innerHTML = state.jobs
    .map((j) => `<option value="${escapeHtml(j.code)}">${escapeHtml(j.name)}</option>`)
    .join("");
}

/* ---------- あいまい一致 ---------- */

function scoreMatch(description, job) {
  const text = (job.name + " " + job.code).toLowerCase();
  const descLower = description.toLowerCase();
  let score = 0;
  if (job.code && descLower.includes(job.code.toLowerCase())) score += 100;
  const tokens = descLower.split(/[\s、,。/_・\-()（）]+/).filter((t) => t.length >= 2);
  for (const t of tokens) {
    if (text.includes(t)) score += t.length;
  }
  return score;
}

// 登録済みキーワードの中から一致するものを探す。
// 完全一致を優先し、無ければ部分一致(最長キーワード優先)を探す。
function findAliasMatch(groups, normDescLower) {
  for (const g of groups) {
    for (const kw of g.keywords || []) {
      if (kw.trim().toLowerCase() === normDescLower) return { group: g, keyword: kw };
    }
  }
  let best = null;
  for (const g of groups) {
    for (const kw of g.keywords || []) {
      const kwLower = kw.trim().toLowerCase();
      if (kwLower && normDescLower.includes(kwLower)) {
        if (!best || kwLower.length > best.keyword.trim().length) {
          best = { group: g, keyword: kw };
        }
      }
    }
  }
  return best;
}

// エイリアスを優先し、無ければあいまい一致にフォールバックする
function matchJobs(items, jobs, groups) {
  return items.map((item) => {
    const normDescLower = item.description.trim().toLowerCase();
    const aliasHit = findAliasMatch(groups, normDescLower);

    if (aliasHit) {
      const job = jobs.find((j) => j.code === aliasHit.group.jobCode) || null;
      return {
        ...item,
        matchedJob: job,
        matchScore: job ? 1000 : -1,
        aliasUsed: aliasHit.keyword,
        aliasMissing: !job,
      };
    }

    // あいまい一致(フォールバック)
    let best = null;
    let bestScore = 0;
    for (const job of jobs) {
      const s = scoreMatch(item.description, job);
      if (s > bestScore) {
        bestScore = s;
        best = job;
      }
    }
    return { ...item, matchedJob: best, matchScore: bestScore, aliasUsed: null, aliasMissing: false };
  });
}

function rematchAndRender() {
  renderJobCodeOptions();
  if (state.items.length > 0) {
    state.items = matchJobs(state.items, state.jobs, aliasGroups);
  }
  renderItems();
}

/* ---------- UI State & Rendering ---------- */

const state = {
  items: [],
  jobs: [],
  summaryText: "",
  workDialogFrameId: null,
};

function el(id) {
  return document.getElementById(id);
}

function renderItems() {
  const container = el("itemsContainer");
  if (state.items.length === 0) {
    container.textContent = "まだ読み込んでいません。";
    return;
  }

  const table = document.createElement("table");
  table.innerHTML = `
    <thead>
      <tr>
        <th style="width:22px;"><input type="checkbox" id="checkAll" checked></th>
        <th>元の行 / 抽出テキスト</th>
        <th style="width:58px;">モード</th>
        <th style="width:55px;">時間(min)</th>
        <th>マッチした案件</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector("tbody");

  state.items.forEach((item, i) => {
    const tr = document.createElement("tr");
    const hasJobs = state.jobs.length > 0;
    let scoreClass = "";
    if (item.aliasMissing) {
      scoreClass = "score-none";
    } else if (hasJobs) {
      if (!item.matchedJob) scoreClass = "score-none";
      else if (!item.aliasUsed && item.matchScore < 6) scoreClass = "score-low";
    }
    tr.className = scoreClass;

    const optionsHtml = hasJobs
      ? [`<option value="-1">(反映しない)</option>`]
          .concat(
            state.jobs.map(
              (j) =>
                `<option value="${j.index}" ${
                  item.matchedJob && item.matchedJob.index === j.index ? "selected" : ""
                }>${escapeHtml(j.name)} [${escapeHtml(j.code)}]</option>`
            )
          )
          .join("")
      : `<option value="-1">(先に③で案件一覧を取得してください)</option>`;

    let badgeHtml = "";
    if (item.aliasUsed) {
      badgeHtml = `<span class="badge badge-alias">エイリアス一致: ${escapeHtml(item.aliasUsed)}</span>`;
      if (item.aliasMissing) {
        badgeHtml += `<span class="badge badge-missing">案件が見つかりません(要ジョブ追加)</span>`;
      }
    }

    const isPercent = item.mode === "percent";
    const modeOptionsHtml = `
      <option value="time" ${!isPercent ? "selected" : ""}>時間</option>
      <option value="percent" ${isPercent ? "selected" : ""}>自動</option>
    `;

    // 表示・入力は分(min)単位。内部の状態(item.hours)は時間の小数で保持し続ける。
    const minutesValue = item.hours === null ? "" : Math.round(item.hours * 60);

    tr.innerHTML = `
      <td><input type="checkbox" class="rowCheck" data-i="${i}" ${item.matchedJob ? "checked" : ""}></td>
      <td><textarea class="raw" data-i="${i}">${escapeHtml(item.description)}</textarea>${badgeHtml}</td>
      <td><select class="mode" data-i="${i}">${modeOptionsHtml}</select></td>
      <td><input type="number" step="5" min="0" class="hours" data-i="${i}" value="${minutesValue}" ${isPercent ? "disabled placeholder=\"残り時間\"" : ""}></td>
      <td><select class="job" data-i="${i}">${optionsHtml}</select></td>
    `;
    tbody.appendChild(tr);
  });

  container.innerHTML = "";
  container.appendChild(table);

  // Wire up edits
  container.querySelectorAll("textarea.raw").forEach((t) =>
    t.addEventListener("input", (e) => {
      state.items[+e.target.dataset.i].description = e.target.value;
    })
  );
  container.querySelectorAll("select.mode").forEach((s) =>
    s.addEventListener("change", (e) => {
      const i = +e.target.dataset.i;
      const item = state.items[i];
      item.mode = e.target.value;
      const hoursInput = container.querySelector(`input.hours[data-i="${i}"]`);
      if (item.mode === "percent") {
        item.hours = null;
        if (hoursInput) {
          hoursInput.value = "";
          hoursInput.disabled = true;
          hoursInput.placeholder = "残り時間";
        }
      } else {
        item.hours = item.hours || 0;
        if (hoursInput) {
          hoursInput.disabled = false;
          hoursInput.value = Math.round(item.hours * 60);
        }
      }
    })
  );
  container.querySelectorAll("input.hours").forEach((t) =>
    t.addEventListener("input", (e) => {
      // 入力値は分(min)。内部状態は時間の小数に変換して保持する。
      const minutes = parseFloat(e.target.value) || 0;
      state.items[+e.target.dataset.i].hours = Math.round((minutes / 60) * 100) / 100;
    })
  );
  container.querySelectorAll("select.job").forEach((s) =>
    s.addEventListener("change", (e) => {
      const idx = parseInt(e.target.value, 10);
      state.items[+e.target.dataset.i].selectedJobIndex = idx >= 0 ? idx : null;
    })
  );
  container.querySelectorAll("select.job").forEach((s) => {
    const i = +s.dataset.i;
    const item = state.items[i];
    item.selectedJobIndex = item.matchedJob ? item.matchedJob.index : null;
  });

  el("checkAll").addEventListener("change", (e) => {
    container.querySelectorAll(".rowCheck").forEach((c) => (c.checked = e.target.checked));
  });

  el("fillBtn").disabled = state.jobs.length === 0;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------- Event Wiring ---------- */

el("pickVaultBtn").addEventListener("click", async () => {
  try {
    await pickVault();
    el("vaultStatus").textContent = "フォルダを選択しました。";
    el("loadNoteBtn").disabled = false;
  } catch (e) {
    el("vaultStatus").textContent = "選択がキャンセルされました、または失敗しました。";
  }
});

el("dateInput").valueAsDate = new Date();

el("loadNoteBtn").addEventListener("click", async () => {
  const dateStr = el("dateInput").value; // YYYY-MM-DD
  if (!dateStr) return;
  el("noteStatus").textContent = "読み込み中...";
  try {
    if (!vaultHandle) {
      const restored = await restoreVault();
      if (!restored) {
        el("noteStatus").textContent = "フォルダへのアクセス権がありません。①でフォルダを選び直してください。";
        return;
      }
    }
    const filename = `${dateStr}.md`;
    const text = await findAndReadNote(vaultHandle, filename);
    if (text === null) {
      el("noteStatus").textContent = `${filename} が見つかりませんでした。`;
      return;
    }
    state.items = parseNote(text);
    state.items = matchJobs(state.items, state.jobs, aliasGroups);
    state.summaryText = extractHeadingSection(text, "やったこと");
    el("noteStatus").textContent = `${filename} を読み込みました。抽出行数: ${state.items.length}`;
    renderItems();
  } catch (e) {
    el("noteStatus").textContent = "エラー: " + e.message;
  }
});

el("getJobsBtn").addEventListener("click", async () => {
  el("jobsStatus").textContent = "取得中...";
  try {
    const jobs = (await executeInWorkDialogFrame(scrapeJobsInPage)) || [];
    state.jobs = jobs;
    if (jobs.length === 0) {
      el("jobsStatus").textContent =
        "案件が見つかりませんでした。TeamSpiritで「工数実績入力」ダイアログを開いた状態で再度お試しください。";
    } else {
      el("jobsStatus").textContent = `案件を${jobs.length}件取得しました。`;
      state.items = matchJobs(state.items, state.jobs, aliasGroups);
    }
    renderJobCodeOptions();
    renderAliasRows(); // 案件名表示を更新
    renderItems();
  } catch (e) {
    el("jobsStatus").textContent =
      "エラー: " + e.message + "（TeamSpiritを開いているか確認してください。Chromeアプリ化した独立ウィンドウでも自動的に探します）";
  }
});

el("fillBtn").addEventListener("click", async () => {
  const container = el("itemsContainer");
  const checks = container.querySelectorAll(".rowCheck");
  const checkedItems = [];
  const skippedMissing = [];
  checks.forEach((c) => {
    if (!c.checked) return;
    const i = +c.dataset.i;
    const item = state.items[i];
    if (item.aliasMissing) {
      skippedMissing.push(item.aliasUsed);
      return;
    }
    if (item.selectedJobIndex === null || item.selectedJobIndex === undefined) return;
    if (item.mode === "percent") {
      checkedItems.push(item); // 自動モードは時間の値が無くても対象にする
      return;
    }
    if (!item.hours || item.hours <= 0) return;
    checkedItems.push(item);
  });

  if (checkedItems.length === 0) {
    let msg = "反映対象がありません（案件が選択されているか、時間が入力されているか確認してください）。";
    if (skippedMissing.length > 0) {
      msg += ` エイリアス「${skippedMissing.join("、")}」に対応する案件が現在のダイアログに見つからないためスキップしました。TeamSpirit側で「ジョブを追加」してから③を再取得してください。`;
    }
    el("fillStatus").textContent = msg;
    return;
  }

  const timeItems = checkedItems.filter((item) => item.mode !== "percent");
  const percentItems = checkedItems.filter((item) => item.mode === "percent");

  // 同じ案件(selectedJobIndex)にマッチした時間指定行は時間を合算する
  const groupMap = new Map();
  for (const item of timeItems) {
    if (!groupMap.has(item.selectedJobIndex)) {
      groupMap.set(item.selectedJobIndex, { jobIndex: item.selectedJobIndex, totalHours: 0, items: [] });
    }
    const g = groupMap.get(item.selectedJobIndex);
    g.totalHours += item.hours;
    g.items.push(item);
  }
  const groups = [...groupMap.values()];
  const entries = groups.map((g) => ({ index: g.jobIndex, hoursDecimal: Math.round(g.totalHours * 100) / 100 }));

  // 「自動」指定の行は、案件(selectedJobIndex)の重複を除いてモード切替だけ行う
  const percentIndexes = [...new Set(percentItems.map((item) => item.selectedJobIndex))];

  // 自由入力欄(作業報告)には、マッチした案件ごとにグループ化して、
  // その下に元のノートの行(個別の内容)をネストして転記する。
  // 例:
  //   - {案件名}
  //     - {元の行1}
  //     - {元の行2}
  const transcribeReport = el("transcribeReportCheck").checked;
  const reportGroupMap = new Map();
  for (const item of checkedItems) {
    if (!reportGroupMap.has(item.selectedJobIndex)) {
      reportGroupMap.set(item.selectedJobIndex, []);
    }
    reportGroupMap.get(item.selectedJobIndex).push(item);
  }
  const reportLines = [];
  if (state.summaryText) {
    reportLines.push("やったこと");
    reportLines.push(state.summaryText);
    reportLines.push(""); // 「やったこと」と「工数詳細」の間に空行を入れる
  }
  reportLines.push("工数詳細");
  for (const [jobIndex, itemsForJob] of reportGroupMap.entries()) {
    const job = state.jobs.find((j) => j.index === jobIndex);
    const label = job ? job.name : `行#${jobIndex}`;
    reportLines.push(`- ${label}`);
    for (const item of itemsForJob) {
      const content = item.raw.replace(/^[-*]\s*/, ""); // 元の行の先頭の箇条書き記号は重複するので除去
      reportLines.push(`  - ${content}`);
    }
  }
  const reportText = reportLines.join("\n");

  el("fillStatus").textContent = "反映中...";
  try {
    let applied = [];
    if (entries.length > 0) {
      applied = (await executeInWorkDialogFrame(fillEntriesInPage, [entries])) || [];
    }

    let percentApplied = [];
    if (percentIndexes.length > 0) {
      percentApplied = (await executeInWorkDialogFrame(setPercentModeInPage, [percentIndexes])) || [];
    }

    if (entries.length > 0 && applied.length === 0) {
      el("fillStatus").textContent =
        "反映結果を取得できませんでした。TeamSpiritの「工数実績入力」ダイアログが開いているか確認してください。";
      return;
    }

    let reportResult = null;
    if (transcribeReport) {
      reportResult = await executeInWorkDialogFrame(setWorkReportInPage, [reportText]);
    }

    const okCount = applied.filter((r) => r.ok).length;
    const failCount = applied.length - okCount;
    const percentOkCount = percentApplied.filter((r) => r.ok).length;
    const percentFailCount = percentApplied.length - percentOkCount;

    const summaryLines = groups.map((g) => {
      const job = state.jobs.find((j) => j.index === g.jobIndex);
      const label = job ? job.name : `行#${g.jobIndex}`;
      return `・${label}: ${g.totalHours.toFixed(2)}h（${g.items.length}行を合算）`;
    });
    const percentSummaryLines = percentIndexes.map((idx) => {
      const job = state.jobs.find((j) => j.index === idx);
      const label = job ? job.name : `行#${idx}`;
      return `・${label}: 自動モードに切替`;
    });

    let msg = "";
    if (groups.length > 0) {
      msg += `${okCount}件の案件に時間を反映しました。\n` + summaryLines.join("\n");
    }
    if (percentIndexes.length > 0) {
      if (msg) msg += "\n";
      msg += `${percentOkCount}件の案件を自動モードに切り替えました。\n` + percentSummaryLines.join("\n");
    }
    if (failCount > 0) {
      msg += `\n失敗: ${failCount}件（` + applied.filter((r) => !r.ok).map((r) => `#${r.index}: ${r.reason}`).join(", ") + `）`;
    }
    if (percentFailCount > 0) {
      msg += `\n自動モード切替の失敗: ${percentFailCount}件（` + percentApplied.filter((r) => !r.ok).map((r) => `#${r.index}: ${r.reason}`).join(", ") + `）`;
    }
    if (transcribeReport) {
      if (reportResult && reportResult.ok) {
        msg += `\n作業報告欄に${checkedItems.length}行を転記しました。`;
      } else {
        msg += `\n作業報告欄への転記に失敗しました${reportResult ? "（" + reportResult.reason + "）" : ""}。`;
      }
    }
    msg += "\n内容を確認し、必ずTeamSpirit側の「登録」ボタンを自分で押してください。";
    el("fillStatus").textContent = msg;
  } catch (e) {
    el("fillStatus").textContent = "エラー: " + e.message;
  }
});

el("addAliasBtn").addEventListener("click", async () => {
  aliasGroups.push({ jobCode: "", keywords: [] });
  await saveAliases();
  renderAliasRows();
});

/* ---------- 初期化 ---------- */

(async () => {
  await loadAliases();
  renderAliasRows();

  const restored = await restoreVault();
  if (restored) {
    el("vaultStatus").textContent = "前回選択したフォルダを復元しました。";
    el("loadNoteBtn").disabled = false;
  }
})();
