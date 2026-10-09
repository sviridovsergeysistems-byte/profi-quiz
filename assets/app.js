/* =====================================================================
   ПРОФИДВЕРИ: квиз для трафика с Авито.
   НАСТРОЙКА: всё, что нужно менять, находится в объекте CONFIG ниже.
   Если ни один канал не заполнен, работает демо-режим: заявка пишется
   в консоль браузера (и в localStorage "pd_demo_leads"), показывается «Спасибо».
   ===================================================================== */
var CONFIG = {
  // (A) ОСНОВНОЙ КАНАЛ: заявка на почту через FormSubmit (formsubmit.co), без регистрации.
  //     Первый раз FormSubmit присылает на этот адрес письмо «Activate Form»,
  //     по кнопке в нём форма включается. После активации FormSubmit присылает
  //     второе письмо со случайной строкой-псевдонимом: вставьте её в formsubmitTo
  //     вместо адреса, тогда почта не будет видна в коде страницы.
  email: {
    formsubmitTo: "sviridovsergeysistems@gmail.com",
    subject: "Заявка с квиза Профидвери"
  },

  // (B) Запасной канал (необязательно): веб-приложение Google Apps Script,
  //     которое пишет письмо с вашего же Gmail. Код: relay/google-apps-script.gs.
  //     Пример: "https://script.google.com/macros/s/AKfy.../exec". Пусто = выключено.
  appsScriptUrl: "",

  // (C) Любой вебхук (Bitrix24, amoCRM, свой сервер): POST с JSON заявки.
  webhookUrl: "",

  // (D) Свой релей в Telegram (relay/*.js). Сейчас не используется.
  relayUrl: "",

  // Яндекс Метрика: номер счётчика (только цифры). Пусто = Метрика не грузится.
  // Цели (создайте в Метрике как «JavaScript-событие» с такими идентификаторами):
  //   quiz_start      нажали «Пройти 4 вопроса»
  //   quiz_q1..quiz_q4 ответили на вопрос 1..4
  //   quiz_form       открыли форму (последний шаг)
  //   lead            отправили заявку (основная цель для оценки рекламы)
  metrikaId: "",      // например "98765432"

  requestTimeoutMs: 10000
};

/* ---------------- Вопросы квиза ---------------- */
var QUESTIONS = [
  { id: "q1", title: "Чем вы сейчас занимаетесь?",
    options: ["Работаю по найму", "Своё дело уже есть", "Ищу себя после декрета или смены работы", "Другое"] },
  { id: "q2", title: "Сколько времени готовы уделять делу?",
    options: ["Вечера и выходные", "Половину дня", "Весь день"] },
  { id: "q3", title: "Что сейчас больше всего не устраивает?",
    options: ["Работа на дядю", "Не хватает денег", "Из-за работы не вижу семью", "Всё сразу"] },
  { id: "q4", title: "Как вам удобнее начать?",
    options: ["Оплатить сразу|225\u00a0000\u00a0₽", "Рассрочка на 12 месяцев|18\u00a0750\u00a0₽ в месяц", "Пока изучаю"] }
];

(function () {
  "use strict";
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var LS = window.localStorage, SS = window.sessionStorage;

  /* ---------- UTM и параметры клика ---------- */
  var UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"];
  var EXTRA_KEYS = ["aviclid", "click_id", "erid", "yclid"];
  function captureParams() {
    var q = new URLSearchParams(location.search), got = {}, has = false;
    UTM_KEYS.concat(EXTRA_KEYS).forEach(function (k) { var v = q.get(k); if (v) { got[k] = v.slice(0, 200); has = true; } });
    try {
      if (has) { got._landing = location.href.slice(0, 1000); got._ts = new Date().toISOString(); LS.setItem("pd_utm", JSON.stringify(got)); return got; }
      return JSON.parse(LS.getItem("pd_utm") || "{}");   // последний источник с метками
    } catch (e) { return got; }
  }
  var PARAMS = captureParams();

  /* ---------- Яндекс Метрика ---------- */
  function initMetrika() {
    if (!CONFIG.metrikaId) return;
    /* стандартный код счётчика Яндекс Метрики */
    (function (m, e, t, r, i, k, a) { m[i] = m[i] || function () { (m[i].a = m[i].a || []).push(arguments); }; m[i].l = 1 * new Date();
      k = e.createElement(t); a = e.getElementsByTagName(t)[0]; k.async = 1; k.src = r; a.parentNode.insertBefore(k, a);
    })(window, document, "script", "https://mc.yandex.ru/metrika/tag.js", "ym");
    window.ym(Number(CONFIG.metrikaId), "init", { clickmap: true, trackLinks: true, accurateTrackBounce: true, webvisor: true,
      params: { utm_content: PARAMS.utm_content || "", utm_term: PARAMS.utm_term || "" } });
  }
  function goal(name, params) {
    try { if (CONFIG.metrikaId && window.ym) window.ym(Number(CONFIG.metrikaId), "reachGoal", name, params || {}); } catch (e) {}
    if (!CONFIG.metrikaId) console.debug("[goal]", name, params || "");
  }
  initMetrika();

  /* ---------- Состояние и навигация ---------- */
  var state = { step: "start", answers: {} };   // step: start | 0..3 | form | thanks
  try { var saved = JSON.parse(SS.getItem("pd_state") || "null"); if (saved && saved.answers) state.answers = saved.answers; } catch (e) {}
  function save() { try { SS.setItem("pd_state", JSON.stringify(state)); } catch (e) {} }

  function show(step, push) {
    state.step = step; save();
    var scr = step === "start" ? "start" : step === "form" ? "form" : step === "thanks" ? "thanks" : "q";
    $$(".screen").forEach(function (s) { s.classList.toggle("on", s.getAttribute("data-screen") === scr); });
    if (scr === "q") renderQuestion(step);
    if (scr === "form") goal("quiz_form");
    if (push !== false) { try { history.pushState({ step: step }, "", location.pathname + location.search + "#" + (typeof step === "number" ? "q" + (step + 1) : step)); } catch (e) {} }
    window.scrollTo(0, 0);
  }
  window.addEventListener("popstate", function (e) {
    var st = e.state && e.state.step !== undefined ? e.state.step : "start";
    if (state.step === "thanks") { history.pushState({ step: "thanks" }, "", "#thanks"); return; }   // после заявки назад не уходим
    show(st, false);
  });

  function back() { history.length > 1 ? history.back() : show(prevOf(state.step)); }
  function prevOf(st) { if (st === "form") return QUESTIONS.length - 1; if (st === 0) return "start"; return typeof st === "number" ? st - 1 : "start"; }
  $$("[data-back]").forEach(function (b) { b.addEventListener("click", back); });

  /* ---------- Вопросы ---------- */
  var busy = false;
  function renderQuestion(i) {
    var q = QUESTIONS[i];
    $("#qMeta").textContent = "Вопрос " + (i + 1) + " из " + QUESTIONS.length;
    $("#qBar").style.width = ((i + 1) / (QUESTIONS.length + 1) * 100) + "%";
    $("#qTitle").textContent = q.title;
    var box = $("#qOpts"); box.innerHTML = "";
    q.options.forEach(function (raw) {
      var parts = raw.split("|"), label = parts[0];
      var b = document.createElement("button");
      b.type = "button"; b.className = "opt"; b.setAttribute("role", "radio");
      var on = state.answers[q.id] === label;
      if (on) b.classList.add("on");
      b.setAttribute("aria-checked", on ? "true" : "false");
      var span = document.createElement("span"); span.textContent = label;
      if (parts[1]) { var sm = document.createElement("small"); sm.textContent = parts[1]; span.appendChild(sm); }
      var dot = document.createElement("i"); dot.className = "dot";
      b.appendChild(span); b.appendChild(dot);
      b.addEventListener("click", function () {
        if (busy) return; busy = true;
        $$(".opt", box).forEach(function (o) { o.classList.remove("on"); o.setAttribute("aria-checked", "false"); });
        b.classList.add("on"); b.setAttribute("aria-checked", "true");
        state.answers[q.id] = label; save();
        goal("quiz_" + q.id, { answer: label });
        setTimeout(function () { busy = false; show(i + 1 < QUESTIONS.length ? i + 1 : "form"); }, 260);   // один тап = ответ
      });
      box.appendChild(b);
    });
  }

  $("#startBtn").addEventListener("click", function () { goal("quiz_start"); show(0); });

  /* ---------- Телефон: маска +7 (XXX) XXX-XX-XX ---------- */
  var phone = $("#phone");
  function digits(v) {
    var d = String(v).replace(/\D/g, "");
    if (d.length > 10 && (d[0] === "7" || d[0] === "8")) d = d.slice(1);
    else if (d.length === 11 && d[0] === "8") d = d.slice(1);
    return d.slice(0, 10);
  }
  function fmt(d) {
    if (!d) return "";
    var s = "+7\u00a0(" + d.slice(0, 3);
    if (d.length > 3) s += ")\u00a0" + d.slice(3, 6);
    if (d.length > 6) s += "-" + d.slice(6, 8);
    if (d.length > 8) s += "-" + d.slice(8, 10);
    return s;
  }
  phone.addEventListener("focus", function () { if (!phone.value) phone.value = "+7\u00a0("; });
  phone.addEventListener("blur", function () { if (!digits(phone.value)) phone.value = ""; });
  phone.addEventListener("input", function () {
    var raw = phone.value.replace(/^\+7[\s\u00a0]?\(?/, "");
    var d = raw.replace(/\D/g, "");
    if (d.length === 11 && (d[0] === "7" || d[0] === "8")) d = d.slice(1);   // вставка 8XXXXXXXXXX / 7XXXXXXXXXX
    d = d.slice(0, 10);
    phone.value = d ? fmt(d) : "+7\u00a0(";
    $("#f-phone").classList.remove("bad");
  });
  function phoneDigits() { var raw = phone.value.replace(/^\+7[\s\u00a0]?\(?/, ""); return raw.replace(/\D/g, "").slice(0, 10); }

  /* ---------- Мессенджер ---------- */
  var via = "";
  $$(".chip").forEach(function (c) {
    c.addEventListener("click", function () {
      via = c.getAttribute("data-via");
      $$(".chip").forEach(function (x) { var on = x === c; x.classList.toggle("on", on); x.setAttribute("aria-checked", on ? "true" : "false"); });
      $("#f-via").classList.remove("bad");
    });
  });
  $("#name").addEventListener("input", function () { $("#f-name").classList.remove("bad"); });
  $("#consent").addEventListener("change", function () { $("#f-consent").classList.remove("bad"); });

  /* ---------- Заявка ---------- */
  function buildPayload(name, d) {
    var answers = QUESTIONS.map(function (q) { return { id: q.id, question: q.title, answer: state.answers[q.id] || "" }; });
    var utm = {}; UTM_KEYS.forEach(function (k) { utm[k] = PARAMS[k] || ""; });
    return {
      id: "pd-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7),
      created_at: new Date().toISOString(),
      source: "quiz",
      name: name,
      phone: "+7" + d,
      phone_formatted: fmt(d).replace(/\u00a0/g, " "),
      contact_via: via,
      answers: answers,
      utm: utm,
      aviclid: PARAMS.aviclid || "",
      click_id: PARAMS.click_id || "",
      landing_url: PARAMS._landing || location.href,
      page_url: location.href,
      referrer: document.referrer || "",
      user_agent: navigator.userAgent,
      consent: true,
      consent_doc: "consent.html v1"
    };
  }
  function leadText(p) {
    var L = ["Новая заявка с квиза ПРОФИДВЕРИ", "",
      "Имя: " + p.name, "Телефон: " + p.phone_formatted, "Куда прислать: " + p.contact_via, ""];
    p.answers.forEach(function (a) { L.push(a.question + " " + (a.answer || "—")); });
    L.push("", "utm_source: " + (p.utm.utm_source || "—"), "utm_medium: " + (p.utm.utm_medium || "—"),
      "utm_campaign: " + (p.utm.utm_campaign || "—"), "utm_content: " + (p.utm.utm_content || "—"),
      "utm_term: " + (p.utm.utm_term || "—"));
    if (p.aviclid) L.push("aviclid: " + p.aviclid);
    L.push("", "Время: " + new Date(p.created_at).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" }) + " МСК", "ID: " + p.id);
    return L.join("\n");
  }
  function emailFields(p) {
    var f = { _subject: CONFIG.email.subject + (p.retried ? " (повтор)" : ""), _template: "table", _captcha: "false" };
    f["Имя"] = p.name; f["Телефон"] = p.phone_formatted; f["Куда прислать"] = p.contact_via;
    p.answers.forEach(function (a, i) { f[(i + 1) + ". " + a.question] = a.answer || "—"; });
    ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"].forEach(function (k) { f[k] = p.utm[k] || "—"; });
    f["aviclid"] = p.aviclid || "—";
    f["Время (МСК)"] = new Date(p.created_at).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" });
    f["Страница"] = p.landing_url; f["ID заявки"] = p.id;
    return f;
  }
  function withTimeout(promise) {
    return Promise.race([promise, new Promise(function (_, rej) { setTimeout(function () { rej(new Error("timeout")); }, CONFIG.requestTimeoutMs); })]);
  }
  function okOrThrow(r) { if (!r.ok && r.type !== "opaque") throw new Error("HTTP " + r.status); return r; }
  function sendLead(p) {
    var jobs = [];
    if (CONFIG.relayUrl) jobs.push(withTimeout(fetch(CONFIG.relayUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p), keepalive: true })).then(okOrThrow));
    if (CONFIG.email && CONFIG.email.formsubmitTo) {
      jobs.push(withTimeout(fetch("https://formsubmit.co/ajax/" + encodeURIComponent(CONFIG.email.formsubmitTo), {
        method: "POST", headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify(emailFields(p)), keepalive: true
      })).then(okOrThrow).then(function (r) { return r.json(); }).then(function (j) {
        // До активации FormSubmit хранит заявки 30 дней и пришлёт их после нажатия «Activate Form»,
        // поэтому ответ «needs Activation» тоже считаем принятым (иначе будут дубли).
        if (j && /activat/i.test(String(j.message || ""))) { console.warn("FormSubmit: форма ждёт активации, заявка сохранена у сервиса"); return j; }
        if (!j || String(j.success) !== "true") throw new Error("formsubmit: " + (j && j.message || "no success"));
        return j;
      }));
    }
    if (CONFIG.appsScriptUrl) {
      // no-cors: ответ не читается, считаем отправленным, если запрос ушёл без сетевой ошибки
      jobs.push(withTimeout(fetch(CONFIG.appsScriptUrl, { method: "POST", mode: "no-cors", headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ subject: CONFIG.email.subject, text: leadText(p), lead: p }), keepalive: true })));
    }
    if (CONFIG.webhookUrl) jobs.push(withTimeout(fetch(CONFIG.webhookUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p), keepalive: true })).then(okOrThrow));
    if (!jobs.length) {
      console.info("[ДЕМО-РЕЖИМ] заявка не отправлена, каналы не настроены в CONFIG:\n" + leadText(p), p);
      try { var arr = JSON.parse(LS.getItem("pd_demo_leads") || "[]"); arr.push(p); LS.setItem("pd_demo_leads", JSON.stringify(arr.slice(-20))); } catch (e) {}
      return Promise.resolve({ demo: true });
    }
    return Promise.all(jobs.map(function (j) { return j.then(function () { return true; }, function (e) { console.warn("lead channel failed", e); return false; }); }))
      .then(function (res) { if (res.indexOf(true) === -1) throw new Error("all channels failed"); return { sent: true }; });
  }
  /* очередь: если все каналы упали (нет сети), заявка повторится при следующем открытии страницы */
  function queue(p) { try { var a = JSON.parse(LS.getItem("pd_queue") || "[]"); a.push(p); LS.setItem("pd_queue", JSON.stringify(a.slice(-10))); } catch (e) {} }
  function flushQueue() {
    var a; try { a = JSON.parse(LS.getItem("pd_queue") || "[]"); } catch (e) { a = []; }
    if (!a.length) return; LS.setItem("pd_queue", "[]");
    a.forEach(function (p) { p.retried = true; sendLead(p).catch(function () { queue(p); }); });
  }
  setTimeout(flushQueue, 1500);

  $("#leadForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var name = $("#name").value.trim(), d = phoneDigits(), okAll = true;
    if (name.length < 2) { $("#f-name").classList.add("bad"); okAll = false; }
    if (d.length !== 10) { $("#f-phone").classList.add("bad"); okAll = false; }
    if (!via) { $("#f-via").classList.add("bad"); okAll = false; }
    if (!$("#consent").checked) { $("#f-consent").classList.add("bad"); okAll = false; }
    if (!okAll) { var first = $(".bad"); if (first) first.scrollIntoView({ behavior: "smooth", block: "center" }); return; }
    if ($("#website").value) { show("thanks"); return; }   // ловушка для ботов

    var btn = $("#sendBtn"); btn.disabled = true; btn.textContent = "Отправляем…";
    var p = buildPayload(name, d);
    sendLead(p).catch(function () { queue(p); }).then(function () {
      goal("lead", { contact_via: via, utm_content: p.utm.utm_content, utm_term: p.utm.utm_term });
      $("#tTitle").textContent = "Спасибо, " + name + "!";
      $("#tText").textContent = via === "Позвоните"
        ? "Перезвоним на " + fmt(d) + " в рабочее время и расскажем подробности."
        : "Пришлём подробности в " + via + " на номер " + fmt(d) + ". Напишем в рабочее время.";
      btn.disabled = false; btn.textContent = "Узнать подробнее";
      try { SS.removeItem("pd_state"); } catch (e) {}
      show("thanks");
    });
  });

  /* стартовая точка */
  try { history.replaceState({ step: "start" }, "", location.pathname + location.search); } catch (e) {}
})();
