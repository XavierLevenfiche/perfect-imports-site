// Existing attribution rules, shared with form initialization; no policy changes.
if (document.querySelector('form[action="/api/inquiry"]')) {

    (function () {
      var KEY = 'perfect-imports:inquiry-attribution:v1';
      var FIELDS = ['gclid', 'gbraid', 'wbraid', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];

      function originPath(value) {
        if (!value) return '';
        try {
          var url = new URL(value, window.location.href);
          return url.origin + url.pathname;
        } catch (e) {
          return '';
        }
      }

      function hostFrom(value) {
        if (!value) return '';
        try {
          return new URL(value, window.location.href).hostname.toLowerCase();
        } catch (e) {
          return '';
        }
      }

      function simpleHost(host) {
        return String(host || '').toLowerCase().replace(/^www\./, '');
      }

      function looksLikeSearchEngine(value) {
        var s = simpleHost(value);
        if (['google', 'bing', 'yahoo', 'duckduckgo', 'ddg', 'ecosia', 'yandex',
             'baidu', 'ask', 'aol', 'brave', 'qwant', 'startpage'].indexOf(s) !== -1) return true;
        return /(^|\.)(google\.[a-z]{2,}(\.[a-z]{2})?|bing\.com|search\.yahoo\.com|duckduckgo\.com|ecosia\.org|yandex\.[a-z.]+|baidu\.com|ask\.com|aol\.com|search\.brave\.com|qwant\.com|startpage\.com)$/.test(s);
      }

      function paidSearchMedium(value) {
        var medium = String(value || '').toLowerCase().replace(/[\s_]+/g, '-');
        return ['cpc', 'ppc', 'paid', 'paid-search', 'sem'].indexOf(medium) !== -1;
      }

      function externalReferrerHost(host) {
        var refHost = simpleHost(host);
        var here = simpleHost(window.location.hostname);
        return refHost && refHost !== here;
      }

      function collect() {
        var params = new URLSearchParams(window.location.search || '');
        var out = {};
        FIELDS.forEach(function (field) {
          var value = params.get(field);
          if (value) out[field] = value;
        });
        out.landing_path = originPath(window.location.href);
        out.landing_referrer = originPath(document.referrer);

        var refHost = hostFrom(document.referrer);
        if (out.gclid || out.gbraid || out.wbraid) out.channel = 'paid-search';
        else if (looksLikeSearchEngine(out.utm_source) && paidSearchMedium(out.utm_medium)) out.channel = 'paid-search';
        else if (looksLikeSearchEngine(out.utm_source) && (!out.utm_medium || /^(organic|seo)$/i.test(out.utm_medium))) out.channel = 'organic';
        else if (out.utm_source && paidSearchMedium(out.utm_medium)) out.channel = 'unknown';
        else if (out.utm_source) out.channel = 'referral';
        else if (looksLikeSearchEngine(refHost)) out.channel = 'organic';
        else if (externalReferrerHost(refHost)) out.channel = 'referral';
        else out.channel = 'direct';
        return out;
      }

      function readStored() {
        try {
          var raw = window.sessionStorage.getItem(KEY);
          var parsed = raw ? JSON.parse(raw) : null;
          return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
        } catch (e) {
          return null;
        }
      }

      function writeStored(value) {
        try {
          window.sessionStorage.setItem(KEY, JSON.stringify(value));
        } catch (e) {
          /* Storage can be disabled; current-page attribution still applies. */
        }
      }

      function hasClickId(value) {
        return !!(value && (value.gclid || value.gbraid || value.wbraid));
      }

      function isAttributable(value) {
        return !!(value && value.channel && value.channel !== 'direct' && value.channel !== 'unknown');
      }

      function choose(stored, current) {
        if (!stored) return current;
        // A fresh click id is stronger than stale session attribution, including an
        // earlier organic/referral visit in the same tab.
        if (hasClickId(current)) return current;
        if (isAttributable(current) && !isAttributable(stored)) return current;
        return stored;
      }

      var current = collect();
      writeStored(choose(readStored(), current));
      window.piInquiryAttribution = {
        get: function () {
          return readStored() || current;
        },
        apply: function (formData) {
          var data = this.get();
          ['channel', 'landing_path', 'landing_referrer'].concat(FIELDS).forEach(function (field) {
            if (data && data[field]) formData.set(field, data[field]);
          });
          return formData;
        }
      };
    })();
  
}
/* Shared browser contract: acceptance requires HTTP success and confirmed storage. */
(function () {
  'use strict';
  var RECEIPT_KEY = 'perfect-imports:inquiry-receipt:v1';
  var CONFIRMATION_AGE = 30 * 60 * 1000;
  function validId(value) {
    return typeof value === 'string' && value.length <= 64 &&
      /^inq:[0-9TZ:-]+:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  }
  function storedReceipt() {
    try {
      var receipt = JSON.parse(window.sessionStorage.getItem(RECEIPT_KEY));
      var age = Date.now() - receipt.at;
      return validId(receipt.id) && Number.isFinite(receipt.at) && age >= 0 && age < CONFIRMATION_AGE ? receipt : null;
    } catch (error) { return null; }
  }
  var confirmation = document.getElementById('inquiry-confirmation');
  if (confirmation && storedReceipt()) {
    confirmation.textContent = 'Thanks — I have your enquiry.';
    document.getElementById('inquiry-receipt-state').textContent = 'Received';
    document.getElementById('inquiry-confirmation-copy').textContent = 'I read these myself and usually reply the same day. If it is urgent, email me directly at';
  }
  // Page loads/reloads are never conversion evidence. Only the accepted POST below is.
  Array.prototype.forEach.call(document.querySelectorAll('form[action="/api/inquiry"]'), function (form) {
    var status = form.querySelector('[role="status"]');
    // Without a status target, leave the browser's native POST fallback intact.
    if (!status) return;
    var button = form.querySelector('button[type="submit"]');
    var inFlight = false;
    var accepted = false;
    function retry(message) {
      inFlight = false;
      if (button) button.disabled = false;
      status.textContent = message;
    }
    function complete(id) {
      accepted = true;
      status.textContent = 'Thanks — your enquiry has been received. I usually reply the same day.';
      var canNavigate = false;
      try {
        var serialized = JSON.stringify({ id: id, at: Date.now() });
        window.sessionStorage.setItem(RECEIPT_KEY, serialized);
        canNavigate = window.sessionStorage.getItem(RECEIPT_KEY) === serialized;
      } catch (error) { /* Storage blocked: keep the confirmed receipt on this form. */ }
      var finished = false;
      function finish() {
        if (finished) return;
        finished = true;
        if (canNavigate) window.location.assign('/thanks/');
      }
      // Queue all existing events before callbacks can navigate. Wait for both
      // callbacks on the bonded form, with one bounded fallback if scripts block.
      var sendTo = form.getAttribute('data-conversion-send-to');
      if (typeof window.gtag !== 'function') { finish(); return; }
      var pending = sendTo ? 2 : 1;
      var queued = false;
      function callbackForEvent() {
        var done = false;
        return function () {
          if (done) return;
          done = true;
          pending -= 1;
          if (queued && pending === 0) finish();
        };
      }
      setTimeout(finish, 2000);
      var leadDone = callbackForEvent();
      try {
        window.gtag('event', 'generate_lead', {
          currency: 'USD', value: 0, transaction_id: id,
          event_callback: leadDone, event_timeout: 2000
        });
      } catch (error) { leadDone(); }
      if (sendTo) {
        var conversionDone = callbackForEvent();
        try {
          window.gtag('event', 'conversion', {
            send_to: sendTo, transaction_id: id,
            event_callback: conversionDone, event_timeout: 2000
          });
        } catch (error) { conversionDone(); }
      }
      queued = true;
      if (pending === 0) finish();
    }
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      if (inFlight || accepted) return;
      inFlight = true;
      if (button) button.disabled = true;
      status.textContent = 'Sending...';
      try { window.sessionStorage.removeItem(RECEIPT_KEY); } catch (error) { /* Optional storage. */ }
      var controller = typeof AbortController === 'function' ? new AbortController() : null;
      var timeout = controller ? setTimeout(function () { controller.abort(); }, 15000) : null;
      var formData;
      try {
        formData = new FormData(form);
        if (window.piInquiryAttribution && window.piInquiryAttribution.apply) {
          window.piInquiryAttribution.apply(formData);
        }
      } catch (error) {
        if (timeout) clearTimeout(timeout);
        retry('We could not prepare your enquiry. Please email froy@perfect-imports.com.');
        return;
      }
      var options = { method: 'POST', headers: { Accept: 'application/json' }, body: formData };
      if (controller) options.signal = controller.signal;
      fetch(form.action, options)
        .then(function (response) {
          return response.json().then(function (body) { return { httpOk: response.ok, body: body }; });
        })
        .then(function (reply) {
          if (timeout) clearTimeout(timeout);
          var body = reply.body;
          if (reply.httpOk && body && body.ok === true && body.accepted === true && body.stored === true && validId(body.inquiry_id)) {
            complete(body.inquiry_id);
            return;
          }
          retry((body && typeof body.error === 'string' && body.error) || 'We could not confirm your enquiry was received. Please retry or email froy@perfect-imports.com.');
        })
        .catch(function () {
          if (timeout) clearTimeout(timeout);
          if (!accepted) retry('We could not confirm your enquiry was received. Please retry or email froy@perfect-imports.com.');
        });
    });
  });
})();
