let activePopover = null;

function normalizeCommandName(value) {
  return String(value || '')
    .trim()
    .replace(/^\/+/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function skillCommandName(skill) {
  return normalizeCommandName(skill?.name || skill?.id) || 'skill';
}

function promptCommandName(prompt) {
  return normalizeCommandName(prompt?.name || prompt?.id) || 'prompt';
}

function appendSkillId(skillIds, skillId) {
  const current = Array.isArray(skillIds) ? skillIds : [];
  const value = String(skillId || '').trim();
  if (!value || current.includes(value)) return [...current];
  return [...current, value];
}

function removeSkillId(skillIds, skillId) {
  const value = String(skillId || '').trim();
  return (Array.isArray(skillIds) ? skillIds : []).filter((id) => id !== value);
}

function appendPromptId(promptIds, promptId) {
  const current = Array.isArray(promptIds) ? promptIds : [];
  const value = String(promptId || '').trim();
  if (!value || current.includes(value)) return [...current];
  return [...current, value];
}

function removePromptId(promptIds, promptId) {
  const value = String(promptId || '').trim();
  return (Array.isArray(promptIds) ? promptIds : []).filter((id) => id !== value);
}

function filterComposerCommands(commands, query) {
  const normalized = String(query || '').trim().toLowerCase();
  if (!normalized) return [...commands];
  return commands.filter((command) => `${command.name || ''} ${command.search || ''} ${command.description || ''}`
    .toLowerCase()
    .includes(normalized));
}

function findSlashCommand(text, cursor = String(text || '').length) {
  const value = String(text || '');
  const position = Math.max(0, Math.min(Number(cursor) || 0, value.length));
  let start = position;
  while (start > 0 && !/\s/.test(value[start - 1])) start -= 1;

  let end = position;
  while (end < value.length && !/\s/.test(value[end])) end += 1;

  const token = value.slice(start, end);
  if (!token.startsWith('/')) return null;
  const command = token.slice(1);
  if (command.includes('/') || command.includes('\\') || command.includes(':')) return null;
  if (command.includes('.')) return null;

  return {
    start,
    end,
    token,
    query: command,
    cursor: position,
  };
}

function removeSlashCommandToken(text, { start, end } = {}) {
  const value = String(text || '');
  const tokenStart = Math.max(0, Number(start) || 0);
  const tokenEnd = Math.max(tokenStart, Math.min(Number(end) || tokenStart, value.length));
  const before = value.slice(0, tokenStart);
  let after = value.slice(tokenEnd);

  if (/^\s/.test(after) && (/\s$/.test(before) || tokenStart === 0)) {
    after = after.slice(1);
  }

  const nextText = `${before}${after}`;
  return {
    text: nextText,
    cursor: Math.min(tokenStart, nextText.length),
  };
}

function closeComposerPopover() {
  if (!activePopover) return false;
  const current = activePopover;
  activePopover = null;
  current.close();
  return true;
}

function createComposerPopover({ anchor, align = 'start', placement = 'auto', width = null, onClose = null } = {}) {
  closeComposerPopover();

  const root = anchor?.getRootNode?.();
  const popover = anchor.ownerDocument.createElement('div');
  popover.className = 'composer-popover';
  popover.setAttribute('role', 'menu');
  if (width) popover.style.width = width;
  if (root?.append) root.append(popover);
  else anchor.parentElement?.append(popover);

  let closed = false;
  const reposition = () => {
    if (closed) return;
    const bounds = anchor.getBoundingClientRect();
    const size = popover.getBoundingClientRect();
    const gutter = 8;
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 360;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 600;
    const maxLeft = Math.max(gutter, viewportWidth - size.width - gutter);
    const left = align === 'end'
      ? Math.min(maxLeft, Math.max(gutter, bounds.right - size.width))
      : Math.min(maxLeft, Math.max(gutter, bounds.left));
    const below = bounds.bottom + 6;
    const above = bounds.top - size.height - 6;
    let top;
    if (placement === 'above') {
      top = above >= gutter ? above : below;
    } else if (placement === 'below') {
      top = below;
    } else {
      top = below + size.height <= viewportHeight - gutter || above < gutter
        ? below
        : above;
    }
    const maxTop = Math.max(gutter, viewportHeight - size.height - gutter);
    popover.style.left = `${Math.round(Math.min(maxLeft, Math.max(gutter, left)))}px`;
    popover.style.top = `${Math.round(Math.min(maxTop, Math.max(gutter, top)))}px`;
  };

  const close = () => {
    if (closed) return;
    closed = true;
    if (activePopover?.popover === popover) activePopover = null;
    anchor.ownerDocument.removeEventListener('pointerdown', onPointerDown);
    anchor.ownerDocument.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('resize', reposition);
    root?.removeEventListener?.('scroll', reposition, true);
    popover.remove();
    onClose?.();
  };

  const onPointerDown = (event) => {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
    if (path.includes(anchor) || path.includes(popover)) return;
    close();
  };

  const onKeyDown = (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close();
    anchor.focus?.();
  };

  anchor.ownerDocument.addEventListener('pointerdown', onPointerDown);
  anchor.ownerDocument.addEventListener('keydown', onKeyDown);
  window.addEventListener('resize', reposition);
  root?.addEventListener?.('scroll', reposition, true);
  activePopover = { anchor, close, popover };
  reposition();

  return {
    anchor,
    popover,
    close,
    reposition,
    focusFirst() {
      popover.querySelector('button, [role="menuitem"]')?.focus();
    },
    isOpen() {
      return !closed && popover.isConnected;
    },
  };
}

module.exports = {
  appendPromptId,
  appendSkillId,
  closeComposerPopover,
  createComposerPopover,
  filterComposerCommands,
  findSlashCommand,
  promptCommandName,
  removeSlashCommandToken,
  removePromptId,
  removeSkillId,
  skillCommandName,
};
