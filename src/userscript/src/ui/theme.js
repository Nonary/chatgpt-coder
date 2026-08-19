// ChatGPT records the active theme as a class on <html> and only falls back to
// the operating system preference when neither class is present. Patchwork reads
// the same signal in the same order, so the dock and the composer picker can
// never disagree with the page they are sitting in.
function isDarkTheme() {
  const classes = document.documentElement.classList;
  if (classes.contains('dark')) return true;
  if (classes.contains('light')) return false;
  return matchMedia('(prefers-color-scheme: dark)').matches;
}

// Calls back once immediately and then on every theme change, whether it came
// from ChatGPT's own toggle or from the system switching over.
function observeTheme(onChange) {
  const query = matchMedia('(prefers-color-scheme: dark)');
  const update = () => onChange(isDarkTheme());
  const observer = new MutationObserver(update);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  query.addEventListener('change', update);
  update();
  return () => {
    observer.disconnect();
    query.removeEventListener('change', update);
  };
}

module.exports = { isDarkTheme, observeTheme };
