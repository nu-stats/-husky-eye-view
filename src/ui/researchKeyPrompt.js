/**
 * A small "enter the research key" box for the locked research layers.
 *
 * POWER UP only exists when the local setup endpoint answers (the Pinokio /
 * dev server). Anyone on a shared link or a built copy still needs a way to
 * unlock GVA/MKDB, and the key never goes to a server anyway: it is kept in
 * this browser session only (writeSessionKey), exactly where POWER UP puts it.
 */
// The same sessionStorage slot and change event POWER UP uses
// (SESSION_KEY_SLOTS / SESSION_KEY_EVENT in keySetup.js), which the locked
// layers read (RESEARCH_KEY_SESSION_SLOT / RESEARCH_KEY_EVENT in
// data/localGeojsonCore.js). Kept local so the panel does not pull in POWER UP.
const RESEARCH_KEY_SLOT = 'hev.researchKey';
const RESEARCH_KEY_EVENT = 'hev:research-key-changed';

function writeResearchKey(value) {
  try {
    globalThis.sessionStorage?.setItem(RESEARCH_KEY_SLOT, value);
  } catch {
    return false;
  }
  try {
    globalThis.dispatchEvent?.(new Event(RESEARCH_KEY_EVENT));
  } catch {
    // Layers still re-check the key when they are turned on.
  }
  return true;
}

/**
 * Open the prompt. Resolves true when a key was saved, false when cancelled.
 * Only one prompt is open at a time.
 * @param {{documentRef?: Document, layerName?: string}} [options]
 * @returns {Promise<boolean>}
 */
export function openResearchKeyPrompt({
  documentRef = globalThis.document,
  layerName = 'research layers',
} = {}) {
  if (!documentRef?.body) return Promise.resolve(false);
  documentRef.querySelector('.research-key-prompt')?.remove();
  const opener = documentRef.activeElement;

  return new Promise((resolve) => {
    const dialog = documentRef.createElement('form');
    dialog.className = 'research-key-prompt';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'research-key-prompt-title');

    const title = documentRef.createElement('h2');
    title.id = 'research-key-prompt-title';
    title.textContent = 'Research key';
    const blurb = documentRef.createElement('p');
    blurb.textContent = `Enter the research datasets key to open ${layerName}. It is kept only in this browser tab and is forgotten when the tab closes.`;
    const input = documentRef.createElement('input');
    input.type = 'password';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.required = true;
    input.setAttribute('aria-label', 'Research datasets key');
    const actions = documentRef.createElement('div');
    actions.className = 'research-key-prompt-actions';
    const cancel = documentRef.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    const unlock = documentRef.createElement('button');
    unlock.type = 'submit';
    unlock.textContent = 'Unlock';
    actions.append(cancel, unlock);
    dialog.append(title, blurb, input, actions);

    const close = (saved) => {
      dialog.remove();
      opener?.focus?.({ preventScroll: true });
      resolve(saved);
    };
    dialog.addEventListener('submit', (event) => {
      event.preventDefault();
      const value = input.value.trim();
      if (!value) return;
      close(writeResearchKey(value));
    });
    cancel.addEventListener('click', () => close(false));
    dialog.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close(false);
      }
    });

    documentRef.body.append(dialog);
    input.focus();
  });
}
