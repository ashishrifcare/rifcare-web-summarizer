// popup.js — popup sends summarize request to background service worker

// Global error handlers: show errors in the popup UI to help debug "popup.html:0 (anonymous function)"
window.addEventListener('error', (ev) => {
  try {
    const msg = (ev && ev.message) ? ev.message : String(ev);
    console.error('Popup error caught:', ev);
    const existing = document.getElementById('summaryArea');
    if (existing) existing.textContent = 'Error: ' + msg;
    else {
      const d = document.createElement('div'); d.style.padding='12px'; d.style.color='red'; d.textContent = 'Error: ' + msg; document.body.prepend(d);
    }
  } catch (e) {
    console.error('Failed to display popup error', e);
  }
});
window.addEventListener('unhandledrejection', (ev) => {
  try {
    const reason = ev && ev.reason ? (ev.reason.message || String(ev.reason)) : String(ev);
    console.error('Unhandled promise rejection in popup:', ev);
    const existing = document.getElementById('summaryArea');
    if (existing) existing.textContent = 'Error: ' + reason;
    else { const d = document.createElement('div'); d.style.padding='12px'; d.style.color='red'; d.textContent = 'Error: ' + reason; document.body.prepend(d); }
  } catch (e) { console.error('Failed to display rejection', e); }
});

document.addEventListener('DOMContentLoaded', () => {
  const summarizeBtn = document.getElementById('summarizeBtn');
  let summaryArea = document.getElementById('summaryArea');
  const askBtn = document.getElementById('askBtn');
  const questionInput = document.getElementById('questionInput');
  let answerArea = document.getElementById('answerArea');
  let historyArea = document.getElementById('historyArea');
  const mockToggle = document.getElementById('mockToggle');

  // --- Collapsible toggles for Summary and History ---
  const summaryToggle = document.getElementById('summaryToggle');
  const historyToggle = document.getElementById('historyToggle');
  function setCollapsed(areaEl, toggleBtn, collapsed) {
    if (!areaEl || !toggleBtn) return;
    if (collapsed) {
      areaEl.classList.remove('expanded');
      areaEl.classList.add('collapsed');
      toggleBtn.textContent = '▸';
      toggleBtn.setAttribute('aria-expanded', 'false');
    } else {
      areaEl.classList.remove('collapsed');
      areaEl.classList.add('expanded');
      toggleBtn.textContent = '▾';
      toggleBtn.setAttribute('aria-expanded', 'true');
    }
  }
  // load persisted state
  chrome.storage.local.get(['_popup_collapsed_summary', '_popup_collapsed_history'], (res) => {
    const s = !!res._popup_collapsed_summary;
    const h = !!res._popup_collapsed_history;
    setCollapsed(summaryArea, summaryToggle, s);
    setCollapsed(historyArea, historyToggle, h);
  });
  if (summaryToggle) summaryToggle.addEventListener('click', () => {
    const collapsed = summaryArea.classList.contains('collapsed');
    setCollapsed(summaryArea, summaryToggle, !collapsed);
    chrome.storage.local.set({'_popup_collapsed_summary': !collapsed});
  });
  if (historyToggle) historyToggle.addEventListener('click', () => {
    const collapsed = historyArea.classList.contains('collapsed');
    setCollapsed(historyArea, historyToggle, !collapsed);
    chrome.storage.local.set({'_popup_collapsed_history': !collapsed});
  });

  // Ensure required DOM nodes exist; if not, create simple fallbacks so the popup never throws
  const wrap = document.querySelector('.wrap') || document.body;
  if (!summaryArea) {
    summaryArea = document.createElement('div');
    summaryArea.id = 'summaryArea';
    summaryArea.textContent = 'No summary yet. Click "Summarize Page" to begin.';
    summaryArea.className = 'collapsible expanded';
    wrap.appendChild(summaryArea);
  }
  if (!historyArea) {
    historyArea = document.createElement('div');
    historyArea.id = 'historyArea';
    historyArea.className = 'collapsible expanded small';
    historyArea.textContent = 'No history yet.';
    wrap.appendChild(historyArea);
  }
  if (!answerArea) {
    answerArea = document.createElement('div');
    answerArea.id = 'answerArea';
    answerArea.className = 'small muted';
    wrap.appendChild(answerArea);
  }

  const statusArea = document.createElement('div');
  statusArea.style.fontSize = '12px';
  statusArea.style.color = '#6b7280';
  statusArea.style.marginTop = '6px';
  if (summaryArea.parentNode) summaryArea.parentNode.insertBefore(statusArea, summaryArea.nextSibling);

  function setSummaryText(textArr) {
    if (!textArr || !textArr.length) {
      summaryArea.textContent = 'No summary available.';
      return;
    }
    summaryArea.innerHTML = '<ul>' + textArr.map(b => `<li>${b}</li>`).join('') + '</ul>';
  }

  function sendMessageToBackground(message, timeout = 20000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      try {
        chrome.runtime.sendMessage(message, (resp) => {
          if (settled) return;
          settled = true;
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          resolve(resp);
        });
      } catch (err) {
        if (!settled) { settled = true; reject(err); }
      }
      setTimeout(() => { if (!settled) { settled = true; reject(new Error('Timeout waiting for background response')); } }, timeout);
    });
  }

  summarizeBtn.addEventListener('click', async () => {
    summaryArea.textContent = 'Summarizing...';
    statusArea.textContent = '';
    const [tab] = await chrome.tabs.query({active:true, currentWindow:true});
    if (!tab || !tab.id) {
      summaryArea.textContent = 'No active tab found.';
      return;
    }

    // read mock flag locally and forward to background
    const storage = await new Promise(res => chrome.storage.local.get(['rifcare_mock_mode'], res));
    const mock = !!storage.rifcare_mock_mode;

    try {
      const resp = await sendMessageToBackground({action:'summarize', tabId: tab.id, mock}, 25000);
      if (!resp) throw new Error('No response from background');
      if (resp.status !== 'ok') {
        summaryArea.textContent = 'Error: ' + (resp.message || 'Unknown error from background');
        statusArea.textContent = resp.source ? `Source: ${resp.source}` : '';
        return;
      }

      const raw = String(resp.text || '');
      const [bulletsPart, highlightsPart] = raw.split('===HIGHLIGHTS===');
      const bullets = (bulletsPart||'').split(/\n|\r/).map(l=>l.replace(/^[-\s]*\-?\s*/,'').trim()).filter(Boolean).slice(0,6);
      const highlights = (highlightsPart||'').split(/\n|\r/).map(l=>l.trim()).filter(Boolean).slice(0,5);

      setSummaryText(bullets.length ? bullets : [raw.slice(0,500)]);
      statusArea.textContent = resp.source ? `Source: ${resp.source}` : '';

      // instruct content script to highlight sentences
      try {
        chrome.tabs.sendMessage(tab.id, {action:'highlight_sentences', sentences: highlights}, (hresp) => {
          // If content script isn't present, chrome.runtime.lastError will be set.
          // Check and ignore to prevent unchecked runtime.lastError console warnings.
          if (chrome.runtime.lastError) {
            // silently ignore: content script may not be injected on this page
            return;
          }
          // otherwise, handle response if needed
        });
      } catch (e) {
        // no-op
      }

      // store summary keyed by URL
      const data = {summary: bullets, highlights, raw, updated: Date.now()};
      const o = {}; o[tab.url] = data; chrome.storage.local.set(o, ()=>{});
      loadHistory(tab.url);
    } catch (err) {
      console.error('Summarize failed', err);
      summaryArea.textContent = 'AI error: ' + (err && err.message ? err.message : 'unknown');
      statusArea.textContent = '';
    }
  });

  // Clear button: remove all stored data and clear UI
  const clearBtn = document.getElementById('clearBtn');
  if (clearBtn) {
    clearBtn.addEventListener('click', async () => {
      const ok = confirm('Clear all stored summaries and history? This cannot be undone.');
      if (!ok) return;
      try {
        await new Promise((res) => chrome.storage.local.clear(res));
        // clear UI
        summaryArea.textContent = 'No summary yet. Click "Summarize Page" to begin.';
        historyArea.textContent = 'No history yet.';
        answerArea.textContent = '';
        // also instruct content script to remove highlights by reloading page content (simple approach)
        const [tab] = await chrome.tabs.query({active:true, currentWindow:true});
        if (tab && tab.id) {
          try {
            chrome.tabs.sendMessage(tab.id, {action: 'remove_highlights'}, (r) => {
              if (chrome.runtime.lastError) {
                // ignore when content script is absent or message failed
                return;
              }
            });
          } catch(e){}
        }
      } catch (err) {
        console.error('Clear failed', err);
        alert('Failed to clear storage: ' + (err && err.message ? err.message : String(err)));
      }
    });
  }

  // Ask question — send request to background service worker to perform AI (or fallback)
  askBtn.addEventListener('click', async () => {
    const q = questionInput.value.trim();
    if (!q) return;
    answerArea.textContent = 'Thinking...';
    const [tab] = await chrome.tabs.query({active:true, currentWindow:true});
    if (!tab || !tab.id) { answerArea.textContent = 'No active tab'; return; }
    const storage = await new Promise(res => chrome.storage.local.get(['rifcare_mock_mode'], res));
    const mock = !!storage.rifcare_mock_mode;
    try {
      const resp = await sendMessageToBackground({action:'ask', tabId: tab.id, question: q, mock}, 25000);
      if (!resp) throw new Error('No response from background');
      if (resp.status !== 'ok') {
        answerArea.textContent = 'Error: ' + (resp.message || 'Unknown error');
        return;
      }
      const answerText = resp.answer || resp.text || (resp.data && resp.data.answer) || '';
      answerArea.textContent = answerText || 'No answer available.';
      loadHistory(tab.url);
    } catch (err) {
      console.error('Ask failed', err);
      answerArea.textContent = 'AI error: ' + (err && err.message ? err.message : 'unknown');
    }
  });

  // Load history
  async function loadHistory(url) {
    const key = 'qa_history_' + url;
    chrome.storage.local.get([key], (res) => {
      const hist = res[key] || [];
      if (!hist.length) {
        historyArea.textContent = 'No history yet.';
        return;
      }
      historyArea.innerHTML = hist.slice(-5).reverse().map(h => `<div class="history-item"><strong>Q:</strong> ${h.question}<br/><strong>A:</strong> ${h.answer}</div>`).join('<hr/>');
    });
  }

  // On open, try to show existing summary for the active tab
  (async ()=>{
    const [tab] = await chrome.tabs.query({active:true, currentWindow:true});
    if (!tab) return;
    chrome.storage.local.get([tab.url], (res) => {
      const data = res[tab.url];
      if (data && data.summary) setSummaryText(data.summary);
    });
    loadHistory(tab.url);
    // load mock mode setting
    chrome.storage.local.get(['rifcare_mock_mode'], (res) => {
      if (mockToggle) mockToggle.checked = !!res.rifcare_mock_mode;
    });
  })();

  // Persist mock toggle
  if (mockToggle) {
    mockToggle.addEventListener('change', () => {
      chrome.storage.local.set({rifcare_mock_mode: mockToggle.checked});
    });
  }
});
