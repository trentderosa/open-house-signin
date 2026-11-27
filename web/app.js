/*
 * Guest sign-in form logic. No build step, no libraries.
 * Needs config.js (ENDPOINT_URL) and signin-rules.js (CHOICES, FIELD_LIMITS,
 * validateSignIn, isValidHouseId) to load first.
 */
/* global ENDPOINT_URL, CHOICES, FIELD_LIMITS, HONEYPOT_FIELD, validateSignIn, isValidHouseId, privacyFooterText */
(function () {
  'use strict';

  var REQUEST_TIMEOUT_MS = 25000;
  var REDIRECT_DELAY_MS = 1600;
  var TEXT_FIELDS = ['name', 'phone', 'email', 'comments'];
  var CHOICE_FIELDS = ['agent', 'timeline', 'preapproved', 'heard_from'];
  var ALL_FIELDS = TEXT_FIELDS.concat(CHOICE_FIELDS);

  var state = { houseId: '', branding: {}, submitting: false, sid: '' };

  /**
   * Random id for this form fill. Sent with every attempt, so if a response is
   * lost and the guest taps Sign in again, the endpoint saves it only once.
   */
  function newSubmissionId() {
    var bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    return Array.prototype.map.call(bytes, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  function $(id) { return document.getElementById(id); }

  function show(viewId) {
    ['view-loading', 'view-message', 'view-form', 'view-thanks'].forEach(function (id) {
      $(id).hidden = id !== viewId;
    });
  }

  function showMessage(title, body, canRetry) {
    $('message-title').textContent = title;
    $('message-body').textContent = body;
    $('message-retry').hidden = !canRetry;
    show('view-message');
    $('message-title').focus();
  }

  function endpointConfigured() {
    return typeof ENDPOINT_URL === 'string' &&
      /^https:\/\/script\.google\.com\/(a\/macros\/[^/]+\/|macros\/)s\/[A-Za-z0-9_-]+\/exec$/.test(ENDPOINT_URL);
  }

  function fetchJson(url, options) {
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, REQUEST_TIMEOUT_MS) : null;
    var opts = Object.assign({
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      redirect: 'follow',
      cache: 'no-store'
    }, options || {});
    if (controller) opts.signal = controller.signal;
    return fetch(url, opts)
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .finally(function () { if (timer) clearTimeout(timer); });
  }

  /* ---------- Rendering ---------- */

  function buildChoices() {
    CHOICE_FIELDS.forEach(function (key) {
      var box = document.querySelector('[data-options="' + key + '"]');
      if (!box) return;
      box.textContent = '';
      if (CHOICES[key].length <= 4 && key !== 'preapproved') box.classList.add('compact');
      CHOICES[key].forEach(function (label, i) {
        var wrap = document.createElement('div');
        wrap.className = 'option';
        var input = document.createElement('input');
        input.type = 'radio';
        input.name = key;
        input.id = key + '-' + i;
        input.value = label;
        var lab = document.createElement('label');
        lab.htmlFor = input.id;
        lab.textContent = label;
        wrap.appendChild(input);
        wrap.appendChild(lab);
        box.appendChild(wrap);
      });
    });
    TEXT_FIELDS.forEach(function (key) {
      var el = $(key);
      if (el && FIELD_LIMITS[key]) el.maxLength = FIELD_LIMITS[key];
    });
  }

  function renderHouse(house, branding) {
    var address = house.address || 'Open House';
    $('house-address').textContent = address;
    document.title = 'Sign in \u2014 ' + address;

    var facts = [];
    if (house.beds) facts.push(house.beds + ' bd');
    if (house.baths) facts.push(house.baths + ' ba');
    if (house.sqft) facts.push(house.sqft + ' sq ft');
    var factsEl = $('house-facts');
    factsEl.textContent = '';
    facts.forEach(function (f, i) {
      if (i > 0) {
        var sep = document.createElement('span');
        sep.className = 'sep';
        sep.setAttribute('aria-hidden', 'true');
        sep.textContent = '\u00b7';
        factsEl.appendChild(sep);
      }
      factsEl.appendChild(document.createTextNode(f));
    });
    factsEl.hidden = facts.length === 0;

    if (branding && branding.office_name) $('brand-text').textContent = branding.office_name;
    $('privacy-note').textContent = privacyFooterText(branding && branding.agent_name);
  }

  /** Shows web/assets/logo.svg in the header (falls back to text if missing). */
  function tryLogo() {
    var img = $('brand-logo');
    img.addEventListener('load', function () {
      img.alt = $('brand-text').textContent;
      img.hidden = false;
      $('brand-text').hidden = true;
    });
    img.src = 'assets/logo.svg';
  }

  /* ---------- Errors ---------- */

  function clearErrors() {
    $('form-status').textContent = '';
    ALL_FIELDS.forEach(function (key) {
      var err = $(key + '-error');
      if (err) err.textContent = '';
      var el = $(key);
      if (el) el.removeAttribute('aria-invalid');
    });
  }

  function showErrors(fields, summary) {
    clearErrors();
    var first = null;
    ALL_FIELDS.forEach(function (key) {
      if (!fields || !fields[key]) return;
      var err = $(key + '-error');
      if (err) err.textContent = fields[key];
      var el = $(key) || document.querySelector('input[name="' + key + '"]');
      if ($(key)) $(key).setAttribute('aria-invalid', 'true');
      if (!first && el) first = el;
    });
    $('form-status').textContent = summary || 'Please fix the highlighted fields.';
    if (first) first.focus();
  }

  /* ---------- Submit ---------- */

  function collect(form) {
    var data = { h: state.houseId, sid: state.sid };
    TEXT_FIELDS.forEach(function (key) { data[key] = form.elements[key].value; });
    CHOICE_FIELDS.forEach(function (key) {
      var checked = form.querySelector('input[name="' + key + '"]:checked');
      data[key] = checked ? checked.value : '';
    });
    data[HONEYPOT_FIELD] = form.elements[HONEYPOT_FIELD].value;
    return data;
  }

  function setBusy(busy) {
    state.submitting = busy;
    var btn = $('submit-btn');
    btn.disabled = busy;
    btn.setAttribute('aria-busy', busy ? 'true' : 'false');
    btn.textContent = '';
    if (busy) {
      var spin = document.createElement('span');
      spin.className = 'spinner';
      spin.setAttribute('aria-hidden', 'true');
      btn.appendChild(spin);
    }
    var label = document.createElement('span');
    label.className = 'btn-label';
    label.textContent = busy ? 'Signing you in\u2026' : 'Sign in';
    btn.appendChild(label);
  }

  function safeRedirect(url) {
    return typeof url === 'string' && /^https?:\/\/[^\s"'<>]+$/i.test(url) ? url : '';
  }

  function showThanks(name, redirect) {
    var first = String(name || '').trim().split(/\s+/)[0];
    $('thanks-title').textContent = first ? 'Thanks, ' + first + '.' : 'Thanks for signing in.';
    var agent = state.branding && state.branding.agent_name;
    var body = agent ? agent + ' will follow up soon. Enjoy the tour.' : 'Enjoy the tour.';
    if (redirect) body = 'Enjoy the tour. Opening the agent\u2019s website\u2026';
    $('thanks-body').textContent = body;
    $('thanks-again').hidden = !!redirect;
    show('view-thanks');
    $('thanks-title').focus();
    window.scrollTo(0, 0);
    if (redirect) setTimeout(function () { window.location.replace(redirect); }, REDIRECT_DELAY_MS);
  }

  function onSubmit(ev) {
    ev.preventDefault();
    if (state.submitting) return;
    var form = ev.currentTarget;
    var data = collect(form);

    var check = validateSignIn(data);
    if (!check.ok) {
      if (check.fields && check.fields.h) {
        showMessage('This sign-in link isn\u2019t valid', 'Please ask the agent for help.', false);
        return;
      }
      showErrors(check.fields, check.error);
      return;
    }

    clearErrors();
    setBusy(true);
    fetchJson(ENDPOINT_URL, {
      method: 'POST',
      // text/plain keeps this a "simple" request: no CORS preflight.
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(data)
    })
      .then(function (res) {
        setBusy(false);
        if (res && res.ok) {
          showThanks(check.value.name, safeRedirect(res.redirect));
          return;
        }
        var msg = res && res.error ? res.error : 'Something went wrong. Please try again.';
        if (res && res.fields && res.fields.h) {
          showMessage('This sign-in link isn\u2019t valid', msg, false);
          return;
        }
        showErrors(res && res.fields, msg);
      })
      .catch(function () {
        setBusy(false);
        $('form-status').textContent = 'We couldn\u2019t reach the sign-in service. Check your connection and tap Sign in again. Your answers are still here.';
        $('submit-btn').focus();
      });
  }

  function resetForNextGuest() {
    var form = $('signin-form');
    form.reset();
    state.sid = newSubmissionId();
    clearErrors();
    show('view-form');
    window.scrollTo(0, 0);
    $('name').focus();
  }

  /* ---------- Start ---------- */

  function loadHouse() {
    show('view-loading');
    fetchJson(ENDPOINT_URL + '?h=' + encodeURIComponent(state.houseId), { method: 'GET' })
      .then(function (res) {
        if (!res || !res.ok || !res.house) {
          showMessage('This sign-in link isn\u2019t valid', 'Please ask the agent for help, or scan the QR code again.', false);
          return;
        }
        state.branding = res.branding || {};
        renderHouse(res.house, state.branding);
        show('view-form');
      })
      .catch(function () {
        showMessage('We couldn\u2019t load this open house', 'Check your internet connection and try again.', true);
      });
  }

  function start() {
    if (window.top !== window.self) {
      // Anti-framing (GitHub Pages can't send frame-ancestors).
      document.body.textContent = 'Please open this sign-in page directly.';
      return;
    }

    buildChoices();
    tryLogo();
    $('signin-form').addEventListener('submit', onSubmit);
    $('message-retry').addEventListener('click', loadHouse);
    $('thanks-again').addEventListener('click', resetForNextGuest);

    if (!endpointConfigured()) {
      showMessage('Sign-in isn\u2019t set up yet', 'The agent still needs to finish setting up this form. Please ask them for help.', false);
      return;
    }

    var params = new URLSearchParams(window.location.search);
    var h = (params.get('h') || '').trim().toLowerCase();
    if (!isValidHouseId(h)) {
      showMessage('This sign-in link isn\u2019t valid', 'Please ask the agent for help, or scan the QR code again.', false);
      return;
    }
    state.houseId = h;
    state.sid = newSubmissionId();
    loadHouse();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
