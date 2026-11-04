// ==UserScript==
// @name         Torn Job List - Open Slot Scanner
// @namespace    torn-joblist-scanner
// @version      2.3
// @description  Scans every company on the Job List page and shows which ones have an open employee slot. Includes integrated settings, diagnostics, and PDA support.
// @author       ShavedW00kie (Torn: ThaWookie [2954173] )
// @license      MIT
// @match        https://www.torn.com/joblist.php*
// @match        https://www.torn.com/jobs.php*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_info
// @run-at       document-idle
// @downloadURL  https://update.greasyfork.org/scripts/590281/Torn%20Job%20List%20-%20Open%20Slot%20Scanner.user.js
// @updateURL    https://update.greasyfork.org/scripts/590281/Torn%20Job%20List%20-%20Open%20Slot%20Scanner.meta.js
// ==/UserScript==

(function (GM_info) {
  'use strict';

  // Initialize the modular debugger early to capture the full runtime lifecycle
  const MyDebug = initializeModularDebugger(GM_info ? GM_info.script.name : "Torn Job Scanner");

  // Torn PDA replaces this placeholder if injected natively, utilized as a fallback
  const PDA_APIKEY = '###PDA-APIKEY###';
  const CACHE_TTL = 10 * 60 * 1000; // re-use public data for 10 minutes
  const DELAY_MS = 180;             // well under the 100 calls/minute limit
  const CACHE_PREFIX = 'tjs_';

  /* ---------- storage ---------- */
  const store = {
    get(k, d) {
      try { return typeof GM_getValue === 'function' ? GM_getValue(k, d) : (JSON.parse(localStorage.getItem(k)) ?? d); }
      catch (e) { return d; }
    },
    set(k, v) {
      try { typeof GM_setValue === 'function' ? GM_setValue(k, v) : localStorage.setItem(k, JSON.stringify(v)); }
      catch (e) {}
    }
  };

  /* ---------- helpers ---------- */
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const esc = s => String(s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

  // Removes the API key from anything before it can reach the screen.
  function redact(s) {
    let out = String(s);
    let key = store.get('tjs_apikey', '');
    if (key && !key.startsWith('###')) out = out.split(key).join('[key hidden]');
    return out.replace(/key=[^&\s"']+/gi, 'key=[key hidden]');
  }

  function httpGet(url) {
    return new Promise((resolve, reject) => {
      if (typeof PDA_httpGet === 'function') {
        PDA_httpGet(url)
          .then(r => (r && typeof r.json === 'function') ? r.json().then(resolve) : resolve(JSON.parse(r.responseText)))
          .catch(() => reject(new Error('Request failed')));
      } else if (typeof GM_xmlhttpRequest === 'function') {
        // eslint-disable-next-line no-undef
        GM_xmlhttpRequest({
          method: 'GET', url,
          onload: r => { try { resolve(JSON.parse(r.responseText)); } catch (e) { reject(new Error('Unreadable response')); } },
          onerror: () => reject(new Error('Network error'))
        });
      } else {
        fetch(url).then(r => r.json()).then(resolve).catch(() => reject(new Error('Request failed')));
      }
    });
  }

  /* ---------- reading the page ---------- */
  const RE_COMPANY = /(?:^|[?&#;])(?:company)?ID=(\d+)/i;
  const RE_USER = /(?:XID|userID|user_id)=(\d+)/i;

  function collectCompanies() {
    const found = new Map();
    document.querySelectorAll('a[href], [onclick], [data-company-id], [data-id]').forEach(el => {
      const src = (el.getAttribute('href') || '') + ' ' + (el.getAttribute('onclick') || '');
      let id = null;

      if (el.dataset && /^\d+$/.test(el.dataset.companyId || '')) {
        id = el.dataset.companyId;
      } else {
        const m = src.match(RE_COMPANY);
        const u = src.match(RE_USER);
        if (m && (!u || u[1] !== m[1])) id = m[1];
      }

      if (!id || found.has(id)) return;
      const row = el.closest('li, tr, .job-item, .company-item, div[class*="listItem"], div[class*="row"]') || el;
      found.set(id, { row, el });
    });
    return [...found.entries()].map(([id, v]) => ({ id, row: v.row, el: v.el }));
  }

  /* ---------- API ---------- */
  async function fetchCompany(id, apiKey) {
    const cacheKey = CACHE_PREFIX + id;
    const cached = store.get(cacheKey, null);
    if (cached && Date.now() - cached.t < CACHE_TTL) return cached.d;

    const url = `https://api.torn.com/company/${id}?selections=profile&key=${apiKey}&comment=JobListScanner`;
    const json = await httpGet(url);
    if (json && json.error) throw new Error(`API ${json.error.code}: ${json.error.error}`);

    const c = (json && json.company) || null;
    if (!c || c.employees_capacity === undefined) throw new Error('Empty company profile for ID ' + id);

    const data = {
      id,
      name: c.name || ('Company ' + id),
      rating: c.rating || 0,
      hired: c.employees_hired ?? 0,
      capacity: c.employees_capacity ?? 0
    };
    data.free = Math.max(0, data.capacity - data.hired);
    store.set(cacheKey, { t: Date.now(), d: data });
    return data;
  }

  /* ---------- interface ---------- */
  const style = document.createElement('style');
  style.textContent = `
  #tjs-btn{position:fixed;right:14px;bottom:96px;z-index:99998;width:52px;height:52px;border-radius:26px;
    background:#1f3d2b;color:#8fe3a8;border:1px solid #8fe3a8;font:600 11px/1.1 system-ui,sans-serif;
    display:flex;align-items:center;justify-content:center;box-shadow:0 3px 10px rgba(0,0,0,.5); cursor:pointer;}
  #tjs-btn:active, #tjs-settings-btn:active{transform:scale(.94)}
  #tjs-settings-btn{position:fixed;right:14px;bottom:156px;z-index:99998;width:40px;height:40px;border-radius:20px;
    background:#14181c;color:#8b969f;border:1px solid #2c343b;font-size:18px;
    display:flex;align-items:center;justify-content:center;box-shadow:0 3px 10px rgba(0,0,0,.5); cursor:pointer;}
  #tjs-panel{position:fixed;left:8px;right:8px;bottom:160px;max-height:58vh;overflow:auto;z-index:99998;
    background:#14181c;color:#dfe4e8;border:1px solid #2c343b;border-radius:10px;
    font:13px/1.4 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.6)}
  #tjs-panel header{position:sticky;top:0;background:#1b2126;padding:10px 12px;border-bottom:1px solid #2c343b;
    display:flex;justify-content:space-between;align-items:center;font-weight:600;color:#8fe3a8}
  #tjs-close{background:none;border:none;color:#8b969f;font-size:18px;line-height:1; cursor:pointer;}
  .tjs-item{padding:9px 12px;border-bottom:1px solid #22282e;display:flex;justify-content:space-between;gap:10px}
  .tjs-item small{color:#8b969f;display:block}
  .tjs-err{color:#f0a08f}
  .tjs-code{font:11px/1.35 ui-monospace,monospace;color:#9fb4c7;word-break:break-all;white-space:pre-wrap;
    padding:8px 12px;border-bottom:1px solid #22282e}
  .tjs-free{color:#8fe3a8;font-weight:700;white-space:nowrap}
  .tjs-full{color:#6b757d;white-space:nowrap}
  .tjs-tag{display:inline-block;margin-left:6px;padding:1px 6px;border-radius:8px;font:600 11px system-ui,sans-serif}
  .tjs-tag.ok{background:#1f3d2b;color:#8fe3a8}
  .tjs-tag.no{background:#2a2f34;color:#6b757d}
  .tjs-credit{padding:10px 12px;color:#8b969f;font-size:11px;line-height:1.5;text-align:center}
  .tjs-credit a{color:#8fe3a8;text-decoration:none;font-weight:600}
  
  /* Settings Panel Styles */
  #tjs-settings-panel{position:fixed;top:70px;right:12px;width:330px;max-width:calc(100vw - 24px);
    max-height:calc(100vh - 90px);overflow:auto;padding:16px;background:#14181c;color:#dfe4e8;
    border:1px solid #2c343b;border-radius:10px;z-index:99999;font:13px/1.4 system-ui,sans-serif;
    box-shadow:0 6px 24px rgba(0,0,0,.8);box-sizing:border-box;}
  #tjs-settings-panel[hidden]{display:none!important}
  #tjs-settings-panel h3{margin:0 0 12px;color:#8fe3a8;border-bottom:1px solid #2c343b;padding-bottom:8px;}
  #tjs-settings-panel input{width:100%;box-sizing:border-box;background:#1b2126;color:#fff;
    border:1px solid #2c343b;padding:8px;margin:8px 0 12px;border-radius:4px;}
  #tjs-settings-panel .tjs-actions{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px;}
  #tjs-settings-panel button{background:#1f3d2b;color:#8fe3a8;border:1px solid #8fe3a8;
    border-radius:4px;padding:6px 12px;cursor:pointer;font-weight:bold;}
  #tjs-settings-panel button:hover{background:#2a523a;}
  #tjs-settings-panel hr{border:0;border-top:1px solid #2c343b;margin:12px 0;}
  .tjs-credit-line{margin-top:12px;font-size:11px;color:#8b969f;text-align:center;font-style:italic;}
  
  /* Donation UI Components */
  .tw-support-btn{display:inline-flex;align-items:center;justify-content:center;padding:8px 12px;
    border-radius:6px;font-size:12px;font-weight:bold;color:#fff!important;text-decoration:none!important;
    border:1px solid #555;transition:transform 0.2s ease;cursor:pointer;width:100%;box-sizing:border-box;}
  .tw-support-btn:active{transform:scale(0.95);}
  .tw-bmc{background-color:#FFDD00;color:#000!important;border-color:#FFDD00;}
  .tw-torn-tip{background-color:#8ab63d;border-color:#6a8c2f;}`;
  document.head.appendChild(style);

  const CREDIT = `<div class="tjs-credit">
    Script by <a href="https://www.torn.com/profiles.php?XID=4176329" target="_blank">BistouFlex2000 [4176329]</a><br>
    Saved you some clicking? A Xanax or anything else is always welcome — never required.
  </div>`;

  const btn = document.createElement('div');
  btn.id = 'tjs-btn';
  btn.textContent = 'SCAN';
  document.body.appendChild(btn);

  const settingsBtn = document.createElement('div');
  settingsBtn.id = 'tjs-settings-btn';
  settingsBtn.innerHTML = '⚙️';
  settingsBtn.title = 'Settings';
  document.body.appendChild(settingsBtn);

  let settingsPanel, apikeyInput, settingsStatus;

  function buildSettingsUI() {
    if (document.getElementById('tjs-settings-panel')) return;
    
    settingsPanel = document.createElement('div');
    settingsPanel.id = 'tjs-settings-panel';
    settingsPanel.hidden = true;
    
    settingsPanel.innerHTML = `
      <h3>Scanner Settings</h3>
      <label>Torn API Key (Public Only)</label>
      <input type="password" id="tjs-apikey-input" placeholder="Enter API Key" autocomplete="off">
      <div class="tjs-actions">
        <button id="tjs-save-settings">Save</button>
        <button id="tjs-close-settings">Close</button>
      </div>
      <p id="tjs-settings-status" style="color:#8fe3a8; min-height:18px; margin:0;"></p>
      <hr>
      <div class="tjs-actions">
        <button id="tjs-debug-btn" aria-label="Toggle debug log">🪲 Debugger</button>
        <button id="tjs-copy-debug">📋 Copy Logs</button>
        <a href="https://www.buymeacoffee.com/bittick1c" target="_blank" rel="noopener noreferrer" class="tw-support-btn tw-bmc">☕ Buy Me a Coffee</a>
        <a href="https://www.torn.com/item.php" target="_blank" rel="noopener noreferrer" class="tw-support-btn tw-torn-tip" title="Opens Items — search 'Xanax', tap Send, enter ThaWookie [2954173]">💊 Send a Xanax Tip</a>
      </div>
      <div class="tjs-credit-line">Inspired by the original code by: BistouFlex2000 [4176329]</div>
    `;
    
    document.body.appendChild(settingsPanel);
    
    apikeyInput = settingsPanel.querySelector('#tjs-apikey-input');
    settingsStatus = settingsPanel.querySelector('#tjs-settings-status');
    
    settingsPanel.querySelector('#tjs-close-settings').onclick = () => settingsPanel.hidden = true;
    settingsPanel.querySelector('#tjs-debug-btn').onclick = () => MyDebug.toggleView();
    settingsPanel.querySelector('#tjs-copy-debug').onclick = function () { MyDebug.copy(this); };
    
    settingsPanel.querySelector('#tjs-save-settings').onclick = () => {
      const val = apikeyInput.value.trim();
      store.set('tjs_apikey', val);
      settingsStatus.textContent = "Settings saved securely.";
      MyDebug.log({ event: "settings-saved" });
      setTimeout(() => { if (settingsStatus) settingsStatus.textContent = ""; }, 2500);
    };
  }

  settingsBtn.onclick = () => {
    buildSettingsUI();
    apikeyInput.value = store.get('tjs_apikey', '');
    settingsPanel.hidden = !settingsPanel.hidden;
  };

  function panelBody() {
    let p = document.getElementById('tjs-panel');
    if (!p) {
      p = document.createElement('div');
      p.id = 'tjs-panel';
      p.innerHTML = '<header><span>Open slots</span><button id="tjs-close">✕</button></header><div id="tjs-body"></div>';
      document.body.appendChild(p);
      p.querySelector('#tjs-close').onclick = () => p.remove();
    }
    return p.querySelector('#tjs-body');
  }

  function badge(row, data) {
    if (!row || row.querySelector('.tjs-tag')) return;
    const tag = document.createElement('span');
    tag.className = 'tjs-tag ' + (data.free > 0 ? 'ok' : 'no');
    tag.textContent = data.free > 0 ? `${data.free} open` : 'full';
    (row.querySelector('a') || row).appendChild(tag);
  }

  /* ---------- scan ---------- */
  let running = false;

  btn.onclick = async () => {
    if (running) return;

    let currentKey = store.get('tjs_apikey', '');
    if (currentKey === '' && typeof PDA_APIKEY !== 'undefined' && !PDA_APIKEY.startsWith('###')) {
      currentKey = PDA_APIKEY;
      store.set('tjs_apikey', currentKey); // Auto-migrate PDA key into persistent storage
    }

    if (!currentKey || currentKey.startsWith('###')) {
      buildSettingsUI();
      settingsPanel.hidden = false;
      settingsStatus.textContent = "Please set your API key to begin scanning.";
      MyDebug.warn("Scan attempted without API key.");
      return;
    }

    running = true;
    const body = panelBody();
    const list = collectCompanies();

    if (!list.length) {
      body.innerHTML = '<div class="tjs-item tjs-err">No company found on this page. Open the job list and scan again.</div>';
      running = false;
      return;
    }

    body.innerHTML = '<div class="tjs-item" id="tjs-status"></div>';
    const status = body.querySelector('#tjs-status');
    const results = [], errors = [];

    MyDebug.log({ event: "scan-started", targets: list.length });

    for (let i = 0; i < list.length; i++) {
      status.textContent = `Reading ${i + 1} of ${list.length}…`;
      try {
        const d = await fetchCompany(list[i].id, currentKey);
        results.push(d);
        badge(list[i].row, d);
      } catch (e) {
        errors.push(`ID ${list[i].id} — ${redact(e.message)}`);
        MyDebug.error(`Company fetch failed: ${redact(e.message)}`);
        if (errors.length >= 3 && results.length === 0) break; // key or format issue, stop early
      }
      await sleep(DELAY_MS);
    }

    results.sort((a, b) => b.free - a.free || b.rating - a.rating);
    const free = results.filter(r => r.free > 0).length;

    let html = `<div class="tjs-item"><span>${free} with an open slot out of ${results.length} read</span></div>`;
    html += results.map(r => `
      <div class="tjs-item">
        <div><b>${esc(r.name)}</b><small>${'★'.repeat(r.rating)} · ${r.hired}/${r.capacity} employees</small></div>
        <div class="${r.free > 0 ? 'tjs-free' : 'tjs-full'}">${r.free > 0 ? r.free + (r.free > 1 ? ' slots' : ' slot') : 'full'}</div>
      </div>`).join('');
    if (errors.length) {
      html += `<div class="tjs-item tjs-err">${errors.length} error(s)</div>` +
        errors.slice(0, 5).map(e => `<div class="tjs-code tjs-err">${esc(e)}</div>`).join('');
    }
    html += CREDIT;
    body.innerHTML = html;
    running = false;
    MyDebug.log({ event: "scan-complete", totalFree: free });
  };

/**
 * File: userscript-debugger-module.js
 * Version 1.0.4 (Syntax Corrupted Markdown Fixed)
 * Advanced Modular Userscript Debugger Engine
 * Author: Github.com/ShavedW00kie/
 * Optimized for Desktop PC, Mobile Browsers, and TornPDA Native WebViews
 * License: BSD-3-Clause
 */
function initializeModularDebugger(scriptNamespace = 'App') {
    const randomSuffix = Math.random().toString(36).substring(2, 11);
    const prefix = `us-debug-${randomSuffix}`;
    
    const CLIPBOARD_MAX_CHARS = 10 * 1024 * 1024;
    const BUFFER_REDUCTION_SHY = 900 * 1024;
    const MAX_LOG_STRING_LENGTH = CLIPBOARD_MAX_CHARS - BUFFER_REDUCTION_SHY;

    const state = { logs: [], currentBufferLength: 0, domElements: { container: null, logArea: null } };

    function log(message) {
        const time = new Date().toLocaleTimeString();
        let cleanMessage = '';
        try { cleanMessage = typeof message === 'object' ? JSON.stringify(message) : String(message); } 
        catch (e) { cleanMessage = `[Serialization Error] ${message}`; }
        
        const entry = `[${time}] ${cleanMessage}`;
        const entryLength = entry.length + 1;

        while (state.logs.length > 0 && (state.currentBufferLength + entryLength) > MAX_LOG_STRING_LENGTH) {
            const removed = state.logs.shift();
            if (removed) state.currentBufferLength -= (removed.length + 1);
        }

        if (entryLength <= MAX_LOG_STRING_LENGTH) {
            state.logs.push(entry);
            state.currentBufferLength += entryLength;
        }

        if (state.domElements.logArea) {
            state.domElements.logArea.innerText = state.logs.join('\n');
            if (state.domElements.container) state.domElements.container.scrollTop = state.domElements.container.scrollHeight;
        }
    }

    function warn(message) { log(`[WARN] ${message}`); }
    function error(message) { log(`[ERROR] ${message}`); }

    function copyLogs(buttonElement = null) {
        const payload = state.logs.join('\n');
        if (!payload) {
            if (buttonElement) buttonElement.innerText = "Empty!";
            setTimeout(() => { if (buttonElement) buttonElement.innerText = "Copy Logs"; }, 1500);
            return;
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(payload)
                .then(() => handleCopySuccess(buttonElement))
                .catch(() => handleCopyFallback(payload, buttonElement));
        } else {
            handleCopyFallback(payload, buttonElement);
        }
    }

    function handleCopySuccess(btn) {
        if (!btn) return;
        const baselineText = btn.innerText;
        btn.innerText = "Copied!";
        setTimeout(() => { btn.innerText = baselineText; }, 1500);
    }

    function handleCopyFallback(textData, btn) {
        try {
            const textarea = document.createElement('textarea');
            textarea.value = textData;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            const success = document.execCommand('copy');
            document.body.removeChild(textarea);
            if (success) handleCopySuccess(btn);
            else if (btn) btn.innerText = "Failed!";
        } catch (e) {
            if (btn) btn.innerText = "Error!";
            log(`Fallback copy system error: ${e.message}`);
        }
    }

    function toggleConsoleView() {
        let existingContainer = document.getElementById(`${prefix}-box`);
        if (existingContainer) {
            if (existingContainer.style.display === 'none') {
                existingContainer.style.display = 'block';
                state.domElements.logArea.innerText = state.logs.join('\n');
                existingContainer.scrollTop = existingContainer.scrollHeight;
            } else { existingContainer.style.display = 'none'; }
            return;
        }

        const container = document.createElement('div');
        container.id = `${prefix}-box`;
        container.style.cssText = `position:fixed;bottom:12px;right:12px;width:calc(100% - 24px);max-width:380px;height:250px;background:#181818;color:#00ff66;font-family:monospace;font-size:11px;padding:12px;z-index:2147483647;border:1px solid #00ff66;overflow-y:auto;box-shadow:0 4px 20px rgba(0,0,0,0.7);border-radius:4px;box-sizing:border-box;`;

        const header = document.createElement('div');
        header.style.cssText = `display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;border-bottom:1px solid #333;padding-bottom:5px;user-select:none;`;

        const title = document.createElement('span');
        title.innerText = `DEBUG LOG [${scriptNamespace}]`;
        title.style.cssText = `font-weight:bold;letter-spacing:0.5px;`;

        const buttonGroup = document.createElement('div');
        buttonGroup.style.cssText = `display:flex;gap:6px;`;

        const copyBtn = document.createElement('button');
        copyBtn.innerText = 'Copy';
        copyBtn.style.cssText = `background:#2a2a2a;color:#fff;border:1px solid #444;cursor:pointer;padding:3px 8px;font-size:10px;border-radius:3px;transition:all 0.2s;`;
        copyBtn.onclick = () => copyLogs(copyBtn);

        const closeBtn = document.createElement('button');
        closeBtn.innerText = 'Hide';
        closeBtn.style.cssText = `background:#a82020;color:#fff;border:none;cursor:pointer;padding:3px 8px;font-size:10px;border-radius:3px;`;
        closeBtn.onclick = () => { container.style.display = 'none'; };

        const logArea = document.createElement('div');
        logArea.id = `${prefix}-logs`;
        logArea.style.cssText = `white-space:pre-wrap;word-break:break-all;font-family:monospace;line-height:1.4;`;

        buttonGroup.appendChild(copyBtn);
        buttonGroup.appendChild(closeBtn);
        header.appendChild(title);
        header.appendChild(buttonGroup);
        container.appendChild(header);
        container.appendChild(logArea);
        document.body.appendChild(container);

        state.domElements.container = container;
        state.domElements.logArea = logArea;
        logArea.innerText = state.logs.join('\n');
        container.scrollTop = container.scrollHeight;
    }

    return { log, warn, error, copy: copyLogs, toggleView: toggleConsoleView };
}
})(typeof GM_info !== "undefined" ? GM_info : null);
