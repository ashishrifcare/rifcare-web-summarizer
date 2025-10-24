// content_script.js
// Listens for messages to extract page text, summarize using built-in AI, highlight sentences, and answer questions.

// Utility: get visible text from the page
function getVisibleText() {
  // Use body innerText to approximate visible text
  return document.body ? document.body.innerText : '';
}

// Highlight sentences by wrapping in span.highlighted
function highlightSentences(sentences) {
  // Remove previous highlights
  removeHighlights();

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);

  const sentenceSet = new Set(sentences.map(s => s.trim()).filter(Boolean));
  let highlights = 0;

  for (const node of textNodes) {
    if (highlights >= sentences.length) break;
    const text = node.textContent;
    for (const sentence of sentenceSet) {
      const idx = text.indexOf(sentence);
      if (idx !== -1) {
        const before = document.createTextNode(text.slice(0, idx));
        const span = document.createElement('span');
        span.className = 'rifcare-highlight';
        span.style.background = 'yellow';
        span.style.borderRadius = '3px';
        span.textContent = sentence;
        const after = document.createTextNode(text.slice(idx + sentence.length));
        const parent = node.parentNode;
        parent.insertBefore(before, node);
        parent.insertBefore(span, node);
        parent.insertBefore(after, node);
        parent.removeChild(node);
        highlights++;
        sentenceSet.delete(sentence);
        break;
      }
    }
  }
}

// Remove any existing highlights inserted by this extension
function removeHighlights() {
  const els = Array.from(document.querySelectorAll('.rifcare-highlight'));
  for (const el of els) {
    try {
      const parent = el.parentNode;
      if (!parent) continue;
      parent.replaceChild(document.createTextNode(el.textContent), el);
      parent.normalize();
    } catch (e) { /* ignore */ }
  }
}

// Content script responsibilities:
// - extract visible page text
// - apply highlights on the page when requested
// - store/read small page-local data via chrome.storage.local (optional)

// Extract visible text from page (safe, quick)
function extractPageText() {
  return document.body ? document.body.innerText || '' : '';
}

// Local extractive summarizer used as fallback when AI is unavailable.
// Returns an object: { bullets: [...], highlights: [...], raw: 'formatted string' }
async function summarizeText(raw, maxBullets = 4, maxHighlights = 4) {
  if (!raw) return {bullets: [], highlights: [], raw: ''};
  const text = String(raw).replace(/\s+/g, ' ');
  const sents = text.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
  if (!sents.length) return {bullets: [], highlights: [], raw: ''};

  const stop = new Set(['the','and','is','in','to','of','a','that','it','for','on','with','as','are','was','by','an','be','this','or','from','at','which','you']);
  const freqs = Object.create(null);
  for (const s of sents) {
    const words = s.toLowerCase().replace(/[^a-z0-9\s]/g,'').split(/\s+/).filter(Boolean);
    for (const w of words) { if (!stop.has(w)) freqs[w] = (freqs[w] || 0) + 1; }
  }
  const scored = sents.map(s => {
    const words = s.toLowerCase().replace(/[^a-z0-9\s]/g,'').split(/\s+/).filter(Boolean);
    let score = 0; for (const w of words) if (freqs[w]) score += freqs[w];
    return {s, score};
  });
  scored.sort((a,b)=>b.score - a.score);
  const bullets = scored.slice(0, maxBullets).map(x => x.s.replace(/\s+/g,' ').trim());
  const highlights = [];
  for (const item of scored) {
    if (highlights.length >= maxHighlights) break;
    if (bullets.includes(item.s)) continue;
    if (item.s.split(' ').length < 6) continue;
    highlights.push(item.s);
  }
  while (highlights.length < Math.min(maxHighlights, bullets.length)) highlights.push(bullets[highlights.length] || '');

  const bulletsText = bullets.map(b => `- ${b}`).join('\n');
  const highlightsText = highlights.map(h => h).join('\n');
  const rawOut = bulletsText + '\n\n===HIGHLIGHTS===\n' + highlightsText;
  return {bullets, highlights, raw: rawOut};
}

// Simple QA: find best matching sentence(s) by keyword overlap with the question
async function answerQuestion(pageText, question) {
  try {
    const cleanQ = String(question || '').toLowerCase().replace(/[^a-z0-9\s]/g,'');
    const qWords = cleanQ.split(/\s+/).filter(w => w.length>2);
    const sents = String(pageText || '').replace(/\s+/g,' ').split(/(?<=[.!?])\s+/).map(s=>s.trim()).filter(Boolean);
    if (!sents.length) return {answer: 'No content to answer from.', fallbackUsed:true};

    const scores = sents.map(s => {
      const lw = s.toLowerCase();
      let score = 0;
      for (const w of qWords) if (lw.includes(w)) score += 1;
      return {s, score};
    });
    scores.sort((a,b)=>b.score - a.score);
    const best = scores[0];
    if (best && best.score > 0) return {answer: best.s, fallbackUsed:true};

    // fallback: return first meaningful paragraph or sentence
    const first = sents.find(s => s.split(' ').length > 6) || sents[0] || '';
    return {answer: first, fallbackUsed:true};
  } catch (err) {
    return {answer: 'Failed to generate answer: '+(err && err.message), fallbackUsed:true};
  }
}

// Message handler: only handle extraction and highlighting/storage operations. No AI calls here.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  try {
    if (message.action === 'extract_page') {
      const text = extractPageText();
      sendResponse({status:'ok', text});
      return true;
    }

    if (message.action === 'highlight_sentences') {
      const sentences = Array.isArray(message.sentences) ? message.sentences : [];
      highlightSentences(sentences.slice(0,5));
      sendResponse({status:'ok'});
      return true;
    }

    if (message.action === 'remove_highlights') {
      removeHighlights();
      sendResponse({status:'ok'});
      return true;
    }

    if (message.action === 'store_summary') {
      const url = location.href;
      const data = message.data || {};
      const obj = {};
      obj[url] = data;
      chrome.storage.local.set(obj, () => {
        sendResponse({status:'ok'});
      });
      return true;
    }
  } catch (err) {
    console.error('Content script message error', err);
    sendResponse({status:'error', message: err && err.message});
    return true;
  }
  // unhandled
});

// Message handler
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      if (message.action === 'extract_and_summarize') {
        const text = getVisibleText();
        const url = location.href;
        let result;
        if (message.mock) {
          // Provide a deterministic fake summary for testing
          const fake = {
            bullets: [
              'This page explains the main idea in 3-5 short points.',
              'Important architecture or workflow details are discussed.',
              'Major benefits and trade-offs are highlighted.',
              'Next steps and contact information are provided.'
            ],
            highlights: [
              'This is a highlight sentence one.',
              'This is a highlight sentence two.',
              'This is a highlight sentence three.'
            ],
            raw: 'FAKE_SUMMARY'
          };
          result = fake;
        } else {
          try {
            result = await summarizeText(text.slice(0, 200000)); // limit
          } catch (err) {
            // Try explicit background fallback
            const prompt = `Summarize the following webpage content into 4 concise bullet points and provide 4 highlight-worthy sentences (exact sentence text). Separate bullets with "\n- " and highlight sentences after a delimiter "===HIGHLIGHTS===\n" followed by each sentence on its own line. Content:\n\n${text}`;
            const bgResp = await new Promise((resolve) => {
              try {
                chrome.runtime.sendMessage({action:'call_gemini', prompt, options:{temperature:0.2}}, (r) => {
                  if (chrome.runtime.lastError) return resolve(null);
                  resolve(r);
                });
              } catch (e) { resolve(null); }
            });
            if (bgResp && bgResp.status === 'ok') {
              const raw = String(bgResp.text || '');
              const [bulletsPart, highlightsPart] = raw.split('===HIGHLIGHTS===');
              const bullets = (bulletsPart || '').split(/\n|\r/).map(l=>l.replace(/^-\s*/, '').trim()).filter(Boolean);
              const highlights = (highlightsPart || '').split(/\n|\r/).map(l=>l.trim()).filter(Boolean).slice(0,5);
              result = {bullets, highlights, raw, fallbackUsed: !!bgResp.usedBackground};
            } else {
              throw err;
            }
          }
        }
        // highlight sentences on page
        highlightSentences(result.highlights.slice(0,5));
        // store summary in chrome.storage.local keyed by URL
        const data = {summary: result.bullets, highlights: result.highlights, raw: result.raw, updated: Date.now()};
        const storeObj = {};
        storeObj[url] = data;
        chrome.storage.local.set(storeObj, () => {
          sendResponse({status: 'ok', data, fallbackUsed: !!result.fallbackUsed});
        });
      } else if (message.action === 'ask_question') {
        const text = getVisibleText();
        if (message.mock) {
          const answer = `MOCK ANSWER: I can't access Gemini here, but this is a simulated response to: "${message.question}"`;
          const key = 'qa_history_' + location.href;
          chrome.storage.local.get([key], (res) => {
            const hist = res[key] || [];
            hist.push({question: message.question, answer, at: Date.now()});
            const o = {};
            o[key] = hist;
            chrome.storage.local.set(o, ()=>{});
            sendResponse({status:'ok', answer, fallbackUsed:false});
          });
        } else {
          try {
            const ansObj = await answerQuestion(text.slice(0,200000), message.question);
            const answer = ansObj && ansObj.answer ? ansObj.answer : ansObj;
            const fallbackUsed = !!(ansObj && ansObj.fallbackUsed);
            // store QA in history
            const key = 'qa_history_' + location.href;
            chrome.storage.local.get([key], (res) => {
              const hist = res[key] || [];
              hist.push({question: message.question, answer, at: Date.now()});
              const o = {};
              o[key] = hist;
              chrome.storage.local.set(o, ()=>{});
              sendResponse({status:'ok', answer, fallbackUsed});
            });
          } catch (err) {
            sendResponse({status: 'error', message: err && err.message ? err.message : String(err)});
          }
        }
      }
    } catch (err) {
      console.error(err);
      sendResponse({status: 'error', message: err.message});
    }
  })();
  return true; // indicate async response
});

// Expose a minimal style for highlights
const style = document.createElement('style');
style.textContent = `.rifcare-highlight{background:yellow;padding:2px;border-radius:3px}`;
document.head.appendChild(style);

// Mock-mode banner: insert a small banner when mock mode is active
const mockBannerId = 'rifcare-mock-banner';
function createMockBanner(){
  if (document.getElementById(mockBannerId)) return;
  const div = document.createElement('div');
  div.id = mockBannerId;
  div.textContent = 'Mock mode — simulated AI responses';
  div.style.position = 'fixed';
  div.style.right = '16px';
  div.style.bottom = '16px';
  div.style.background = 'rgba(37,99,235,0.95)';
  div.style.color = '#fff';
  div.style.padding = '8px 12px';
  div.style.borderRadius = '8px';
  div.style.zIndex = 2147483647;
  div.style.boxShadow = '0 6px 24px rgba(2,6,23,0.4)';
  div.style.fontSize = '13px';
  document.body.appendChild(div);
}
function removeMockBanner(){
  const el = document.getElementById(mockBannerId);
  if (el) el.remove();
}

// Observe storage changes to toggle mock banner
chrome.storage && chrome.storage.local && chrome.storage.local.get(['rifcare_mock_mode'], (res)=>{
  if (res && res.rifcare_mock_mode) createMockBanner();
});
chrome.storage && chrome.storage.onChanged && chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.rifcare_mock_mode) {
    if (changes.rifcare_mock_mode.newValue) createMockBanner(); else removeMockBanner();
  }
});
