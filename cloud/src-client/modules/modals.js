// ─── In-page modals ───────────────────────────────────────────────────────
// Replacements for the browser's built-in dialogs in flows that must not fail
// silently.
//
// window.prompt() is unreliable in exactly the situation this app runs in.
// Firefox returns null without showing anything when the page is fullscreen or
// when "Prevent this page from creating additional dialogs" has been ticked
// once; Chrome does the same after the user dismisses a repeated dialog; and
// Electron-hosted webviews (cmux's browser panes) do not implement it at all.
// A null return is indistinguishable from a cancel, so the caller quietly does
// nothing and the feature looks broken with no error anywhere.

// Ask for a URL. Resolves to the trimmed string, or null if cancelled.
export function promptForUrl({ title = 'Enter URL', initialValue = '', confirmLabel = 'Add', placeholder = 'https://example.com' } = {}) {
  return new Promise((resolve) => {
    const existing = document.getElementById('url-prompt-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'url-prompt-overlay';
    overlay.style.cssText = 'position:fixed; top:0; left:0; right:0; bottom:0; z-index:10001; display:flex; align-items:center; justify-content:center; background:rgba(0,0,0,0.7);';

    const box = document.createElement('div');
    box.style.cssText = 'width:440px; max-width:90vw; background:rgba(15,20,35,0.98); border:1px solid rgba(var(--accent-rgb),0.3); border-radius:12px; padding:18px; box-shadow:0 20px 60px rgba(0,0,0,0.6);';

    const heading = document.createElement('div');
    heading.style.cssText = 'font-size:13px; font-weight:500; color:rgba(255,255,255,0.85); margin-bottom:12px;';
    heading.textContent = title;

    const input = document.createElement('input');
    input.type = 'text';
    input.value = initialValue;
    input.placeholder = placeholder;
    input.style.cssText = 'width:100%; box-sizing:border-box; padding:9px 11px; background:rgba(0,0,0,0.35); border:1px solid rgba(255,255,255,0.12); border-radius:7px; color:#fff; font-size:13px; outline:none;';

    const buttons = document.createElement('div');
    buttons.style.cssText = 'display:flex; justify-content:flex-end; gap:8px; margin-top:14px;';

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = 'padding:7px 14px; background:none; border:1px solid rgba(255,255,255,0.15); border-radius:7px; color:rgba(255,255,255,0.6); font-size:12px; cursor:pointer;';

    const confirmBtn = document.createElement('button');
    confirmBtn.textContent = confirmLabel;
    confirmBtn.style.cssText = 'padding:7px 14px; background:rgba(var(--accent-rgb),0.85); border:1px solid rgba(var(--accent-rgb),0.5); border-radius:7px; color:#fff; font-size:12px; cursor:pointer;';

    buttons.appendChild(cancelBtn);
    buttons.appendChild(confirmBtn);
    box.appendChild(heading);
    box.appendChild(input);
    box.appendChild(buttons);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    let settled = false;
    function close(value) {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKeyDown, true);
      overlay.remove();
      resolve(value);
    }

    // Capture phase: the canvas binds single-key shortcuts on document, and
    // typing a URL would otherwise trigger them.
    function onKeyDown(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close(null);
        return;
      }
      if (e.key === 'Enter' && document.activeElement === input) {
        e.preventDefault();
        e.stopPropagation();
        const value = input.value.trim();
        close(value || null);
        return;
      }
      e.stopPropagation();
    }
    document.addEventListener('keydown', onKeyDown, true);

    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(null); });
    cancelBtn.addEventListener('click', () => close(null));
    confirmBtn.addEventListener('click', () => close(input.value.trim() || null));

    input.focus();
    if (initialValue) input.select();
  });
}
