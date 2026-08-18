// One transcript reader for the single embedded ChatGPT browser.
//
// Both update paths use this file: the live path, driven by the page's own DOM
// mutations, and the slower serial poll that covers missed page events. Keeping
// one reader means the native transcript never disagrees with itself depending
// on which path produced the snapshot.
//
// These functions are stringified and evaluated inside the ChatGPT page, so
// they must stay self-contained: no imports, no closure references, no calls
// out to ChatGPT's backend. They read rendered markup and nothing else.

function readChatSnapshotAction() {
  const INLINE_TAGS = new Set([
    'A', 'ABBR', 'B', 'BDI', 'BDO', 'BR', 'CITE', 'CODE', 'DATA', 'DEL', 'DFN', 'EM', 'I', 'IMG',
    'INS', 'KBD', 'MARK', 'Q', 'S', 'SAMP', 'SMALL', 'SPAN', 'STRIKE', 'STRONG', 'SUB', 'SUP',
    'TIME', 'U', 'VAR', 'WBR', 'svg', 'math',
  ]);
  const SKIPPED_TAGS = new Set(['BUTTON', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'svg']);
  const HEADING_LEVELS = { H1: 1, H2: 2, H3: 3, H4: 4, H5: 5, H6: 6 };
  const MAX_DEPTH = 10;

  const raw = (node) => String(node?.textContent || '').replace(/ /g, ' ').replace(/\r\n?/g, '\n');
  const collapse = (value) => String(value || '').replace(/\s+/g, ' ');
  const normalize = (value) => collapse(value).trim();
  const readable = (element) => raw(element)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const roleFromValue = (value) => {
    const normalized = String(value || '').toLowerCase();
    if (/\b(?:assistant|chatgpt|model|completion|response)\b/.test(normalized)) return 'assistant';
    if (/\b(?:user|human|prompt|you)\b/.test(normalized)) return 'user';
    if (/\bsystem\b/.test(normalized)) return 'system';
    return null;
  };
  const roleFromElement = (element) => roleFromValue([
    element?.getAttribute?.('data-message-author-role'),
    element?.getAttribute?.('data-role'),
    element?.getAttribute?.('data-author'),
    element?.getAttribute?.('aria-label'),
    element?.getAttribute?.('data-testid'),
  ].filter(Boolean).join(' '));

  const pushRun = (runs, run) => {
    if (!run.text) return;
    const previous = runs[runs.length - 1];
    if (previous && previous.bold === run.bold && previous.italic === run.italic
      && previous.code === run.code && previous.strike === run.strike && previous.href === run.href) {
      previous.text += run.text;
      return;
    }
    runs.push(run);
  };

  const BASE_STYLE = { bold: false, italic: false, code: false, strike: false, href: '' };

  const appendInline = (node, style, runs) => {
    if (node.nodeType === 3) {
      pushRun(runs, Object.assign({}, style, { text: collapse(raw(node)) }));
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = node.tagName;
    if (tag === 'BR') {
      pushRun(runs, Object.assign({}, style, { text: '\n' }));
      return;
    }
    if (SKIPPED_TAGS.has(tag) || node.getAttribute('aria-hidden') === 'true') return;
    const nested = {
      bold: style.bold || tag === 'STRONG' || tag === 'B',
      italic: style.italic || tag === 'EM' || tag === 'I',
      code: style.code || tag === 'CODE' || tag === 'KBD' || tag === 'SAMP',
      strike: style.strike || tag === 'DEL' || tag === 'S' || tag === 'STRIKE',
      href: style.href || (tag === 'A' ? String(node.getAttribute('href') || '') : ''),
    };
    for (const child of node.childNodes) appendInline(child, nested, runs);
  };

  const trimRuns = (runs) => {
    if (runs.length) {
      runs[0].text = runs[0].text.replace(/^[ \t]+/, '');
      runs[runs.length - 1].text = runs[runs.length - 1].text.replace(/[ \t]+$/, '');
    }
    return runs.filter((run) => run.text);
  };

  const inlineOf = (element) => {
    const runs = [];
    for (const child of element.childNodes) appendInline(child, BASE_STYLE, runs);
    return trimRuns(runs);
  };

  const codeBlock = (pre) => {
    const code = pre.querySelector('code');
    const language = /language-([A-Za-z0-9+#._-]+)/.exec(String(code?.className || ''))?.[1]
      || String(code?.getAttribute?.('data-language') || '');
    return {
      type: 'code',
      language: /^[A-Za-z0-9+#._-]{1,24}$/.test(language) ? language.toLowerCase() : '',
      code: raw(code || pre).replace(/\s+$/, ''),
    };
  };

  const tableBlock = (table) => {
    const cellsOf = (row) => [...row.children]
      .filter((cell) => cell.tagName === 'TH' || cell.tagName === 'TD')
      .map((cell) => inlineOf(cell));
    const header = [...table.querySelectorAll('thead tr')].map(cellsOf).find((row) => row.length) || [];
    const rows = [...table.querySelectorAll('tbody tr')].map(cellsOf).filter((row) => row.length);
    return header.length || rows.length ? { type: 'table', header, rows } : null;
  };

  // Markdown containers freely mix loose text with block elements, most often
  // in a list item whose first line is bare text followed by a nested list.
  // Loose text is buffered and flushed as a paragraph so nothing is dropped.
  const parseBlocks = (root, depth) => {
    if (depth > MAX_DEPTH) return [];
    const blocks = [];
    let buffered = [];
    const flush = () => {
      const inline = trimRuns(buffered);
      if (inline.length) blocks.push({ type: 'paragraph', inline });
      buffered = [];
    };
    for (const child of root.childNodes) {
      if (child.nodeType === 3) {
        appendInline(child, BASE_STYLE, buffered);
        continue;
      }
      if (child.nodeType !== 1) continue;
      const tag = child.tagName;
      if (SKIPPED_TAGS.has(tag) || child.getAttribute('aria-hidden') === 'true') continue;
      if (INLINE_TAGS.has(tag)) {
        appendInline(child, BASE_STYLE, buffered);
        continue;
      }
      flush();
      if (HEADING_LEVELS[tag]) {
        const inline = inlineOf(child);
        if (inline.length) blocks.push({ type: 'heading', level: HEADING_LEVELS[tag], inline });
      } else if (tag === 'P') {
        const inline = inlineOf(child);
        if (inline.length) blocks.push({ type: 'paragraph', inline });
      } else if (tag === 'PRE') {
        const block = codeBlock(child);
        if (block.code) blocks.push(block);
      } else if (tag === 'HR') {
        blocks.push({ type: 'rule' });
      } else if (tag === 'UL' || tag === 'OL') {
        blocks.push(listBlock(child, depth));
      } else if (tag === 'BLOCKQUOTE') {
        const nested = parseBlocks(child, depth + 1);
        if (nested.length) blocks.push({ type: 'quote', blocks: nested });
      } else if (tag === 'TABLE') {
        const block = tableBlock(child);
        if (block) blocks.push(block);
      } else {
        blocks.push(...parseBlocks(child, depth + 1));
      }
    }
    flush();
    return blocks;
  };

  function listBlock(list, depth) {
    const items = [];
    for (const entry of list.children) {
      if (entry.tagName !== 'LI') continue;
      const blocks = parseBlocks(entry, depth + 1);
      const inline = blocks.length && blocks[0].type === 'paragraph' ? blocks.shift().inline : [];
      if (!inline.length && !blocks.length) continue;
      items.push({ inline, blocks });
    }
    const start = Number.parseInt(list.getAttribute('start') || '', 10);
    return {
      type: 'list',
      ordered: list.tagName === 'OL',
      start: Number.isFinite(start) && start > 0 ? start : 1,
      items,
    };
  }

  const inlineText = (inline) => (inline || [])
    .map((run) => (run.code ? '`' + run.text + '`' : run.text))
    .join('');

  const blockText = (block, indent) => {
    if (block.type === 'paragraph') return indent + inlineText(block.inline);
    if (block.type === 'text') return block.text.split('\n').map((line) => indent + line).join('\n');
    if (block.type === 'heading') return indent + '#'.repeat(block.level) + ' ' + inlineText(block.inline);
    if (block.type === 'rule') return indent + '---';
    if (block.type === 'code') {
      const fence = indent + '```';
      return fence + block.language + '\n'
        + block.code.split('\n').map((line) => indent + line).join('\n') + '\n' + fence;
    }
    if (block.type === 'quote') return blocksText(block.blocks, indent + '> ');
    if (block.type === 'list') {
      return block.items.map((item, index) => {
        const marker = block.ordered ? `${block.start + index}. ` : '- ';
        const head = indent + marker + inlineText(item.inline);
        const nested = item.blocks.length ? '\n' + blocksText(item.blocks, indent + '  ') : '';
        return head + nested;
      }).join('\n');
    }
    if (block.type === 'table') {
      const row = (cells) => indent + '| ' + cells.map(inlineText).join(' | ') + ' |';
      const lines = [];
      if (block.header.length) {
        lines.push(row(block.header));
        lines.push(indent + '|' + block.header.map(() => ' --- ').join('|') + '|');
      }
      for (const cells of block.rows) lines.push(row(cells));
      return lines.join('\n');
    }
    return '';
  };

  function blocksText(blocks, indent) {
    return (blocks || [])
      .map((block) => blockText(block, indent))
      .filter((line) => line.trim())
      .join('\n\n');
  }

  const messageParts = (element) => {
    const markdown = element.querySelector('.markdown, [class*="markdown" i]');
    if (markdown) return parseBlocks(markdown, 0);
    const plain = element.querySelector('.whitespace-pre-wrap');
    const text = readable(plain || element);
    return text ? [{ type: 'text', text }] : [];
  };

  const scope = document.querySelector('main') || document.body || document;
  const queryAll = (selector, root) => [...(root || scope).querySelectorAll(selector)];
  const collect = (candidates) => {
    const messages = [];
    const seen = new Set();
    for (const [index, element] of candidates.entries()) {
      const role = roleFromElement(element)
        || roleFromElement(element.querySelector?.('[data-message-author-role], [data-role], [data-author]'));
      if (!role || element.parentElement?.closest?.('[data-message-author-role]')) continue;
      const parts = messageParts(element);
      const content = blocksText(parts, '');
      if (!content) continue;
      const id = element.getAttribute('data-message-id')
        || element.getAttribute('data-testid')
        || `${role}-${index}`;
      if (seen.has(id)) continue;
      seen.add(id);
      messages.push({ id, role, content, parts });
    }
    return messages;
  };

  const primary = queryAll('[data-message-author-role]');
  const messages = collect(primary);
  if (messages.length === 0) {
    messages.push(...collect(queryAll(
      '[data-message-id], [data-testid*="conversation-turn" i], article[data-testid*="turn" i], [data-role], [data-author]',
    )));
  }
  if (messages.length === 0) {
    // Shadow roots are not used by ChatGPT's transcript today. Walking the
    // whole document is far too expensive to repeat on every mutation, so it
    // stays a last resort for markup that has moved behind a shadow boundary.
    const roots = [document];
    const visited = new Set();
    while (roots.length) {
      const root = roots.shift();
      if (!root || visited.has(root)) continue;
      visited.add(root);
      for (const element of root.querySelectorAll('*')) if (element.shadowRoot) roots.push(element.shadowRoot);
    }
    for (const root of visited) {
      if (root === document) continue;
      messages.push(...collect([...root.querySelectorAll('[data-message-author-role], [data-message-id]')]));
    }
  }

  const progress = queryAll('[data-testid*="reasoning" i], [data-testid*="thinking" i], details')
    .map((element) => readable(element))
    .filter(Boolean);
  const thinkingSummary = progress.length ? progress[progress.length - 1] : null;
  const attachments = queryAll('[data-testid*="attachment" i], a[download]')
    .map((element) => normalize(element.getAttribute('download') || element.textContent || element.getAttribute('aria-label')))
    .filter((name) => name && name.length <= 180)
    .map((name) => ({ name, status: 'ready' }));

  return { messages, thinkingSummary, attachments, run: readRunStatusAction() };
}

function readRunStatusAction() {
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const streamPattern = /stop(?: generating| streaming| response)?/i;
  const stopControl = document.querySelector('[data-testid="stop-button"]')
    || [...document.querySelectorAll('button, [role="button"]')].find((element) => streamPattern.test([
      element.getAttribute('aria-label'), element.getAttribute('title'), element.textContent, element.dataset?.testid,
    ].filter(Boolean).join(' ')));
  if (stopControl) return { status: 'streaming', evidence: 'stop-control' };
  if (document.querySelector('.result-streaming, [data-streaming="true"]')) {
    return { status: 'streaming', evidence: 'streaming-turn' };
  }
  const alerts = [...document.querySelectorAll('[role="alert"], [role="alertdialog"], [data-testid*="error" i]')]
    .map((element) => normalize(element.textContent)).filter(Boolean).join(' ');
  if (/(?:something went wrong|generation failed|error generating|unable to generate|network error)/i.test(alerts)) {
    return { status: 'failed', evidence: 'error-notice' };
  }
  const responses = document.querySelectorAll('[data-message-author-role="assistant"], article [data-testid*="conversation-turn" i]');
  return responses.length > 0
    ? { status: 'completed', evidence: 'assistant-turn' }
    : { status: 'unknown', evidence: 'empty-transcript' };
}

// readChatSnapshotAction calls readRunStatusAction, and #execute only ships the
// source of the function it is handed. Compose the two so the page always
// receives both definitions in one evaluation.
function chatSnapshotSource() {
  return `(() => {\n${readRunStatusAction.toString()}\nreturn (${readChatSnapshotAction.toString()})();\n})()`;
}

module.exports = { chatSnapshotSource, readChatSnapshotAction, readRunStatusAction };
