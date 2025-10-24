// background.js - service worker (AI orchestration)

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'summarize-page',
    title: 'Summarize this page',
    contexts: ['page']
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'summarize-page' && tab && tab.id) {
    // Ask content script to extract page text so user can open popup to summarize
    chrome.tabs.sendMessage(tab.id, {action: 'extract_page'}, (r) => {
      if (chrome.runtime.lastError) {
        // content script not present on this page or message failed — ignore
        return;
      }
      // otherwise, we could handle r if needed
    });
  }
});

// Helper: extract page text via content script
// Helper: extract page text. Try messaging the content script first; if that fails
// (e.g. content script not injected or page blocked), fall back to executing a
// small script in the page (MAIN world) to read document.body.innerText.
async function extractPageText(tabId, timeoutMs = 5000) {
  // Try messaging content script
  try {
    const resp = await new Promise((resolve) => {
      let finished = false;
      try {
        chrome.tabs.sendMessage(tabId, {action: 'extract_page'}, (r) => {
          finished = true;
          if (chrome.runtime.lastError) return resolve({ok:false, error: chrome.runtime.lastError.message});
          resolve({ok:true, text: (r && r.text) ? String(r.text) : ''});
        });
      } catch (e) {
        finished = true;
        return resolve({ok:false, error: e && e.message});
      }
      setTimeout(()=>{ if(!finished) resolve({ok:false, error:'timeout extracting page text (message)'}); }, timeoutMs);
    });
    if (resp && resp.ok) return resp;
    // If the message failed because receiving end doesn't exist, we'll fall through
  } catch (e) {
    // continue to fallback
  }

  // Fallback: executeScript in MAIN world to read body text directly
  try {
    const results = await chrome.scripting.executeScript({
      target: {tabId},
      world: 'MAIN',
      func: () => {
        try { return {text: document && document.body ? document.body.innerText : ''}; }
        catch (err) { return {error: String(err)}; }
      }
    });
    if (!results || !results[0]) return {ok:false, error: 'no result from page script'};
    const v = results[0].result;
    if (v && v.error) return {ok:false, error: 'page script error: '+v.error};
    return {ok:true, text: String(v && v.text ? v.text : '')};
  } catch (e) {
    return {ok:false, error: e && e.message ? e.message : String(e)};
  }
}

// Helper: call chrome.ai if available in service worker
async function callChromeAI(prompt, options = {}){
  if (chrome && chrome.ai && chrome.ai.languageModel && chrome.ai.languageModel.create) {
    const model = await chrome.ai.languageModel.create({model: options.model || 'gemini-nano', ...options});
    const response = await model.generate({messages:[{role:'user', content: prompt}], maxOutputTokens: options.maxOutputTokens || 400});
    if (response.candidates && response.candidates[0]) {
      const cand = response.candidates[0];
      if (cand.content && Array.isArray(cand.content)) return cand.content.map(c=>c.text||'').join('');
      return String(cand);
    }
    if (response.output && response.output[0] && response.output[0].content) return response.output[0].content.map(c=>c.text||'').join('');
    return JSON.stringify(response);
  }
  throw new Error('chrome.ai not available in background');
}

// Helper: inject into page context (MAIN world) to call window.ai
async function callWindowAIInPage(tabId, prompt, options = {}){
  try {
    const results = await chrome.scripting.executeScript({
      target: {tabId},
      world: 'MAIN',
      func: async (p, opts) => {
        if (!window.ai || !window.ai.createLanguageModel) return {error: 'window.ai not available'};
        try {
          const model = await window.ai.createLanguageModel({model: opts.model || 'gemini-nano'});
          const res = await model.generate({messages:[{role:'user', content: p}], maxOutputTokens: opts.maxOutputTokens || 400});
          if (res.output && res.output[0] && res.output[0].content) return {text: res.output[0].content.map(c=>c.text||'').join('')};
          if (res.candidates && res.candidates[0] && res.candidates[0].content) return {text: res.candidates[0].content.map(c=>c.text||'').join('')};
          return {text: JSON.stringify(res)};
        } catch (err) {
          return {error: err && err.message ? err.message : String(err)};
        }
      },
      args: [prompt, options]
    });
    if (!results || !results[0]) throw new Error('No result from injected script');
    const v = results[0].result;
    if (v && v.error) throw new Error(v.error);
    return String(v && v.text ? v.text : '');
  } catch (e) {
    throw e;
  }
}

// Simple extractive summarizer fallback (no external AI).
// Produces a human-readable string with bullets and a ===HIGHLIGHTS=== section
function extractiveSummarize(rawText, maxBullets = 4, maxHighlights = 4) {
  if (!rawText || !rawText.trim()) return '';
  // Split into sentences (simple heuristic)
  const sents = rawText.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/).map(s=>s.trim()).filter(Boolean);
  if (!sents.length) return '';

  // Build word frequencies (very small stopword list)
  const stop = new Set(['the','and','is','in','to','of','a','that','it','for','on','with','as','are','was','by','an','be','this','or','from','at','which','you']);
  const freqs = Object.create(null);
  for (const s of sents) {
    const words = s.toLowerCase().replace(/[^a-z0-9\s]/g,'').split(/\s+/).filter(Boolean);
    for (const w of words) {
      if (stop.has(w)) continue;
      freqs[w] = (freqs[w] || 0) + 1;
    }
  }
  // Score sentences
  const scored = sents.map(s => {
    const words = s.toLowerCase().replace(/[^a-z0-9\s]/g,'').split(/\s+/).filter(Boolean);
    let score = 0;
    for (const w of words) if (freqs[w]) score += freqs[w];
    return {s, score};
  });
  scored.sort((a,b)=>b.score - a.score);
  const bullets = scored.slice(0, maxBullets).map(x => x.s.replace(/\s+/g,' ').trim());
  // For highlights, prefer full sentences with highest score that are not the same as bullets
  const highlights = [];
  for (const item of scored) {
    if (highlights.length >= maxHighlights) break;
    if (bullets.includes(item.s)) continue;
    if (item.s.split(' ').length < 6) continue; // skip very short
    highlights.push(item.s);
  }
  // If no highlights found, use bullets as fallback
  while (highlights.length < Math.min(maxHighlights, bullets.length)) highlights.push(bullets[highlights.length] || '');

  // Format output similar to AI: bullets then delimiter and highlights
  const bulletsText = bullets.map(b => `- ${b}`).join('\n');
  const highlightsText = highlights.map(h => h).join('\n');
  return bulletsText + '\n\n===HIGHLIGHTS===\n' + highlightsText;
}

// Main handler: popup requests summarization
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || (message.action !== 'summarize' && message.action !== 'ask')) return;
  (async () => {
    try {
      // determine target tab
      let tabId = message.tabId;
      if (!tabId) {
        const tabs = await chrome.tabs.query({active:true, currentWindow:true});
        if (!tabs || !tabs[0]) return sendResponse({status:'error', message:'No active tab'});
        tabId = tabs[0].id;
      }

      // extract visible text
      const extracted = await extractPageText(tabId);
      if (!extracted.ok) return sendResponse({status:'error', message: 'Failed to extract page text: '+(extracted.error||'unknown')});
      const text = String(extracted.text || '').slice(0, 200000);

      if (message.action === 'summarize') {
        const prompt = `Summarize the following webpage content into 4 concise bullet points and provide 4 highlight-worthy sentences (exact sentence text). Separate bullets with "\\n- " and highlight sentences after a delimiter "===HIGHLIGHTS===\\n" followed by each sentence on its own line. Content:\n\n${text}`;
        // Try chrome.ai in background first
        try {
          const aiText = await callChromeAI(prompt, {temperature:0.2, maxOutputTokens:400});
          return sendResponse({status:'ok', text: aiText, source: 'chrome.ai'});
        } catch (e) {
          // fallback to in-page window.ai call via injection
          try {
            const aiText = await callWindowAIInPage(tabId, prompt, {temperature:0.2, maxOutputTokens:400});
            return sendResponse({status:'ok', text: aiText, source: 'window.ai'});
          } catch (err2) {
            // Both built-in AI paths failed — use extractive summarizer fallback
            try {
              const fallback = extractiveSummarize(text, 4, 4);
              if (fallback && fallback.trim()) {
                return sendResponse({status:'ok', text: fallback, source: 'extractive-fallback'});
              }
              return sendResponse({status:'error', message: 'Gemini Nano not supported on this device or context: '+(err2 && err2.message ? err2.message : String(err2))});
            } catch (fallbackErr) {
              return sendResponse({status:'error', message: 'Gemini Nano not supported and extractive fallback failed: '+(fallbackErr && fallbackErr.message ? fallbackErr.message : String(fallbackErr))});
            }
          }
        }
      }

      if (message.action === 'ask') {
        const question = message.question || '';
        const prompt = `Answer the user's question based on the following webpage content. Provide a concise answer. If you cannot find a direct answer, give a short summary relevant to the question.\n\nQuestion: ${question}\n\nContent:\n${text}`;
        // support mock mode
        if (message.mock) {
          const mockAnswer = `MOCK ANSWER: simulated response to "${question}"`;
          try {
            // persist to storage
            const tabInfo = await chrome.tabs.get(tabId);
            const url = tabInfo && tabInfo.url ? tabInfo.url : 'unknown';
            const key = 'qa_history_' + url;
            chrome.storage.local.get([key], (res) => {
              const hist = res[key] || [];
              hist.push({question, answer: mockAnswer, at: Date.now(), source: 'mock'});
              const o = {}; o[key] = hist; chrome.storage.local.set(o, ()=>{});
            });
          } catch (e) {
            // ignore storage errors
          }
          return sendResponse({status:'ok', answer: mockAnswer, source: 'mock'});
        }
        // Try chrome.ai
        // Attempt AI paths and capture result, then persist
        let finalAnswer = null;
        let finalSource = null;
        try {
          const aiText = await callChromeAI(prompt, {temperature:0.2, maxOutputTokens:300});
          finalAnswer = String(aiText || '');
          finalSource = 'chrome.ai';
        } catch (e) {
          try {
            const aiText = await callWindowAIInPage(tabId, prompt, {temperature:0.2, maxOutputTokens:300});
            finalAnswer = String(aiText || '');
            finalSource = 'window.ai';
          } catch (err2) {
            // fallback: extractive QA using simple keyword overlap
            try {
              const cleanQ = String(question || '').toLowerCase().replace(/[^a-z0-9\s]/g,'');
              const qWords = cleanQ.split(/\s+/).filter(w => w.length>2);
              const sents = String(text || '').replace(/\s+/g,' ').split(/(?<=[.!?])\s+/).map(s=>s.trim()).filter(Boolean);
              const scores = sents.map(s => {
                const lw = s.toLowerCase();
                let score = 0; for (const w of qWords) if (lw.includes(w)) score += 1; return {s, score};
              });
              scores.sort((a,b)=>b.score - a.score);
              const best = scores[0];
              const answer = (best && best.score>0) ? best.s : (sents.find(s=>s.split(' ').length>6)||sents[0]||'No answer found');
              finalAnswer = String(answer || '');
              finalSource = 'extractive-fallback';
            } catch (fallbackErr) {
              return sendResponse({status:'error', message: 'AI not available and extractive fallback failed: '+(fallbackErr && fallbackErr.message ? fallbackErr.message : String(fallbackErr))});
            }
          }
        }

        // Persist QA history under qa_history_<url>
        try {
          const tabInfo = await chrome.tabs.get(tabId);
          const url = tabInfo && tabInfo.url ? tabInfo.url : 'unknown';
          const key = 'qa_history_' + url;
          chrome.storage.local.get([key], (res) => {
            const hist = res[key] || [];
            hist.push({question, answer: finalAnswer, at: Date.now(), source: finalSource});
            const o = {}; o[key] = hist; chrome.storage.local.set(o, ()=>{});
          });
        } catch (e) {
          // ignore storage errors
        }

        return sendResponse({status:'ok', answer: finalAnswer, source: finalSource});
      }
    } catch (err) {
      return sendResponse({status:'error', message: err && err.message ? err.message : String(err)});
    }
  })();
  return true; // keep channel open for async
});
