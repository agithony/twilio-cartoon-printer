/* Themed modal helpers — drop-in replacements for window.alert/confirm/prompt.
   Returns Promises so callers stay linear. Built with DOM methods (not
   innerHTML) so caller-supplied strings can't inject markup.

   API:
     twModal.alert({ title, message, confirmText })             -> Promise<true>
     twModal.confirm({ title, message, confirmText, cancelText, danger })
                                                                -> Promise<boolean>
     twModal.prompt({ title, message, placeholder, defaultValue,
                      confirmText, danger, validate })          -> Promise<string|null>

   Conventions:
     - Clicking the backdrop or pressing Escape resolves with the "cancel"
       value (false for confirm, null for prompt, true for alert — since
       alert is non-destructive).
     - Enter inside a prompt input submits.
     - If two twModal calls race, the newer one replaces the older (the
       previous resolver fires with its cancel value). */
(function(root) {
  var current = null;
  function closeCurrent(result) {
    if (!current) return;
    var resolve = current.resolve;
    var node = current.node;
    var onKey = current.onKey;
    current = null;
    document.removeEventListener("keydown", onKey, true);
    if (node && node.parentNode) node.parentNode.removeChild(node);
    resolve(result);
  }
  function makeBtn(text, cls, role) {
    var b = document.createElement("button");
    b.className = cls;
    b.textContent = text;
    b.setAttribute("data-role", role);
    return b;
  }
  function mount(cancelValue) {
    if (current) closeCurrent(null);
    var backdrop = document.createElement("div");
    backdrop.className = "tw-modal-backdrop";
    var dialog = document.createElement("div");
    dialog.className = "tw-modal";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    backdrop.appendChild(dialog);
    var finalCancel = cancelValue === undefined ? null : cancelValue;
    backdrop.addEventListener("click", function(e) {
      if (e.target === backdrop) closeCurrent(finalCancel);
    });
    var onKey = function(e) {
      if (e.key === "Escape") { e.preventDefault(); closeCurrent(finalCancel); }
    };
    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(backdrop);
    return { node: backdrop, dialog: dialog, onKey: onKey };
  }
  function addHeading(dialog, title, message) {
    if (title) {
      var t = document.createElement("div");
      t.className = "tw-modal-title";
      t.textContent = title;
      dialog.appendChild(t);
    }
    if (message) {
      var m = document.createElement("div");
      m.className = "tw-modal-msg";
      m.textContent = message;
      dialog.appendChild(m);
    }
  }
  function prompt(opts) {
    opts = opts || {};
    return new Promise(function(resolve) {
      var ctx = mount(null);
      current = { node: ctx.node, resolve: resolve, onKey: ctx.onKey };
      addHeading(ctx.dialog, opts.title || "Enter a value", opts.message);
      var input = document.createElement("input");
      input.type = "text";
      input.className = "tw-modal-input";
      input.value = opts.defaultValue || "";
      input.placeholder = opts.placeholder || "";
      ctx.dialog.appendChild(input);
      var err = document.createElement("div");
      err.className = "tw-modal-error";
      ctx.dialog.appendChild(err);
      var actions = document.createElement("div");
      actions.className = "tw-modal-actions";
      var cancel = makeBtn(opts.cancelText || "Cancel", "tw-btn", "cancel");
      var ok = makeBtn(opts.confirmText || "OK", "tw-btn " + (opts.danger ? "tw-btn-danger" : "tw-btn-primary"), "ok");
      actions.appendChild(cancel);
      actions.appendChild(ok);
      ctx.dialog.appendChild(actions);
      setTimeout(function() { input.focus(); input.select(); }, 0);
      var submit = function() {
        var v = input.value;
        if (typeof opts.validate === "function") {
          var msg = opts.validate(v);
          if (msg) { err.textContent = msg; input.focus(); return; }
        }
        closeCurrent(v);
      };
      ok.addEventListener("click", submit);
      cancel.addEventListener("click", function() { closeCurrent(null); });
      input.addEventListener("keydown", function(e) {
        if (e.key === "Enter") { e.preventDefault(); submit(); }
      });
      input.addEventListener("input", function() { err.textContent = ""; });
    });
  }
  function confirm(opts) {
    opts = opts || {};
    return new Promise(function(resolve) {
      var ctx = mount(false);
      current = { node: ctx.node, resolve: resolve, onKey: ctx.onKey };
      addHeading(ctx.dialog, opts.title || "Are you sure?", opts.message);
      var actions = document.createElement("div");
      actions.className = "tw-modal-actions";
      var cancel = makeBtn(opts.cancelText || "Cancel", "tw-btn", "cancel");
      var ok = makeBtn(opts.confirmText || "OK", "tw-btn " + (opts.danger ? "tw-btn-danger" : "tw-btn-primary"), "ok");
      actions.appendChild(cancel);
      actions.appendChild(ok);
      ctx.dialog.appendChild(actions);
      setTimeout(function() { ok.focus(); }, 0);
      ok.addEventListener("click", function() { closeCurrent(true); });
      cancel.addEventListener("click", function() { closeCurrent(false); });
    });
  }
  function alert(opts) {
    opts = opts || {};
    return new Promise(function(resolve) {
      var ctx = mount(true);
      current = { node: ctx.node, resolve: resolve, onKey: ctx.onKey };
      addHeading(ctx.dialog, opts.title || "Heads up", opts.message);
      var actions = document.createElement("div");
      actions.className = "tw-modal-actions";
      var ok = makeBtn(opts.confirmText || "OK", "tw-btn tw-btn-primary", "ok");
      actions.appendChild(ok);
      ctx.dialog.appendChild(actions);
      setTimeout(function() { ok.focus(); }, 0);
      ok.addEventListener("click", function() { closeCurrent(true); });
    });
  }
  // String-shim variants: accept a single string so call sites that used
  // to do `if (!confirm("Are you sure?"))` can become
  // `if (!await twModal.confirmStr("Are you sure?"))` with the smallest
  // possible diff. Prefer the full-opts form for anything bigger than a
  // one-liner. Same for alertStr.
  function confirmStr(message, opts) {
    return confirm(Object.assign({ message: message }, opts || {}));
  }
  function alertStr(message, opts) {
    return alert(Object.assign({ message: message }, opts || {}));
  }
  root.twModal = {
    prompt: prompt, confirm: confirm, alert: alert,
    confirmStr: confirmStr, alertStr: alertStr,
  };
})(typeof window !== "undefined" ? window : this);
