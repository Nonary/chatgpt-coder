// Everything Patchwork believes about ChatGPT's layout is a guess until it is
// measured in the page. This gathers what actually happened - which rules landed,
// what the real boxes are - so the agent log can be read instead of theorised at.

const PROBES = [
  ['shellRoot', '.h-svh.w-screen, .w-screen'],
  ['main', 'main#main, main'],
  ['header', '#page-header'],
  ['thread', '#thread'],
  ['composer', 'form, [data-testid="composer-root"]'],
];

function box(node) {
  if (!node) return null;
  const rect = node.getBoundingClientRect();
  const style = getComputedStyle(node);
  return {
    left: Math.round(rect.left),
    right: Math.round(rect.right),
    width: Math.round(rect.width),
    position: style.position,
    cssWidth: style.width,
    className: String(node.className || '').slice(0, 120),
  };
}

function sheetSummary() {
  const adopted = document.adoptedStyleSheets || [];
  const ours = adopted.filter((sheet) => {
    try {
      return [...sheet.cssRules].some((rule) => String(rule.cssText).includes('patchwork-pushed'));
    } catch {
      return false;
    }
  });
  return {
    adoptedCount: adopted.length,
    patchworkSheets: ours.length,
    ruleCount: ours.reduce((total, sheet) => total + sheet.cssRules.length, 0),
  };
}

function collectLayoutReport(shell) {
  const root = document.documentElement;
  const body = document.body;
  const bodyStyle = body ? getComputedStyle(body) : null;
  const probes = {};
  for (const [name, selector] of PROBES) probes[name] = box(document.querySelector(selector));

  return {
    kind: 'layout',
    url: location.href,
    viewport: { innerWidth: window.innerWidth, innerHeight: window.innerHeight },
    dock: {
      mode: shell?.layoutMode || null,
      hidden: shell?.dock ? shell.dock.hidden : null,
      width: shell?.dock ? Math.round(shell.dock.getBoundingClientRect().width) : null,
      cssVariable: root.style.getPropertyValue('--patchwork-dock-width') || null,
      hostParent: shell?.host?.parentElement?.tagName || null,
    },
    html: {
      hasPushedClass: root.classList.contains('patchwork-pushed'),
      className: String(root.className || '').slice(0, 120),
    },
    body: bodyStyle ? {
      width: Math.round(body.getBoundingClientRect().width),
      cssWidth: bodyStyle.width,
      maxWidth: bodyStyle.maxWidth,
      transform: bodyStyle.transform,
      overflowX: bodyStyle.overflowX,
      isDirectChildOfHtml: body.parentElement === root,
    } : null,
    sheets: sheetSummary(),
    probes,
    picker: {
      installed: Boolean(document.getElementById('patchwork-task-model-selector')),
      suppressionStyle: Boolean(document.getElementById('patchwork-native-model-selector-suppression')),
      slot: Boolean(document.getElementById('patchwork-task-model-selector-slot')),
      label: document.getElementById('patchwork-task-model-selector')?.getAttribute('data-model') || null,
      reasoning: document.getElementById('patchwork-task-model-selector')?.getAttribute('data-reasoning-mode') || null,
    },
  };
}

function reportLayout(api, shell) {
  let report;
  try {
    report = collectLayoutReport(shell);
  } catch (error) {
    report = { kind: 'layout', error: String(error?.message || error) };
  }
  return api.post('/v1/diagnostics', report).catch(() => null);
}

module.exports = { PROBES, collectLayoutReport, reportLayout };
