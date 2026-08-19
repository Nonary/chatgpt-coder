const DISMISSIBLE_LIMIT_NOTICE = /(?:too many requests|messages? limit reached|usage (?:limit|cap) (?:reached|exceeded)|rate limit (?:reached|exceeded)|you(?:['’]ve| have) (?:reached|hit) (?:the |your )?(?:current |daily |monthly |plan )?(?:message |messages |usage |rate |chatgpt )?(?:limit|cap))/i;
const DISMISSIVE_NOTICE_ACTION = /^(?:got it|close|dismiss|ok|okay)$/i;

function normalize(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isDismissibleLimitNotice(value) {
  return DISMISSIBLE_LIMIT_NOTICE.test(normalize(value));
}

// Only ChatGPT's known request-limit dialogs are dismissed. Unrelated prompts,
// including "thinking" dialogs, are left alone.
function dismissBlockingLimitNotice() {
  const exactModal = document.querySelector('[data-testid="modal-conversation-history-rate-limit"]');
  const containers = [
    exactModal,
    ...document.querySelectorAll('[role="alertdialog"], [role="alert"], [data-sonner-toast], [data-testid*="toast"]'),
  ].filter((item, index, all) => item && all.indexOf(item) === index);

  for (const container of containers) {
    const notice = normalize(container.textContent);
    if (container !== exactModal && !DISMISSIBLE_LIMIT_NOTICE.test(notice)) continue;
    const enabledActions = [...container.querySelectorAll('button, [role="button"]')]
      .filter((item) => !item.disabled && item.getAttribute('aria-disabled') !== 'true');
    const button = enabledActions.find((item) => {
      const visibleText = normalize(item.textContent);
      const accessibleLabel = normalize([
        item.getAttribute('aria-label'), item.getAttribute('title'), item.getAttribute('data-testid'),
      ].filter(Boolean).join(' '));
      return DISMISSIVE_NOTICE_ACTION.test(visibleText) || /(?:close|dismiss)/i.test(accessibleLabel);
    }) || (container === exactModal ? enabledActions[0] : null);
    if (!button) continue;
    const action = normalize(button.textContent || button.getAttribute('aria-label'));
    button.click();
    return { dismissed: true, notice: notice.slice(0, 240), action };
  }
  return { dismissed: false };
}

module.exports = {
  DISMISSIBLE_LIMIT_NOTICE,
  DISMISSIVE_NOTICE_ACTION,
  dismissBlockingLimitNotice,
  isDismissibleLimitNotice,
};
