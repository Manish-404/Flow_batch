// Runs in the page's MAIN world at document_start.
// While FlowBatch is attaching a reference image it sets
// <html data-flowbatch-capture="1">. Any file input the page tries to open during that
// window is captured instead of opening the OS file picker, and parked in the DOM so the
// isolated content script can find it and assign files to it.
(() => {
  if (window.__flowBatchHook) return;
  window.__flowBatchHook = true;

  const capturing = () => document.documentElement?.dataset.flowbatchCapture === '1';

  const capture = (input) => {
    if (!(input instanceof HTMLInputElement) || input.type !== 'file' || !capturing()) return false;
    if (!input.isConnected) {
      let holder = document.getElementById('__flowbatch_inputs');
      if (!holder) {
        holder = document.createElement('div');
        holder.id = '__flowbatch_inputs';
        holder.style.display = 'none';
        document.documentElement.appendChild(holder);
      }
      holder.appendChild(input);
    }
    input.setAttribute('data-flowbatch-captured', String(Date.now()));
    return true;
  };

  const origClick = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function (...args) {
    if (capture(this)) return undefined;
    return origClick.apply(this, args);
  };

  const origShowPicker = HTMLInputElement.prototype.showPicker;
  if (origShowPicker) {
    HTMLInputElement.prototype.showPicker = function (...args) {
      if (capture(this)) return undefined;
      return origShowPicker.apply(this, args);
    };
  }

  // Clicks that reach a file input directly (e.g. via a <label>).
  document.addEventListener(
    'click',
    (e) => {
      const t = e.target;
      if (t instanceof HTMLInputElement && capture(t)) e.preventDefault();
    },
    true
  );
})();
