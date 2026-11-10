// Módulo compartido: compra de AulaGame Premium (pago único, de por vida) con PayPal.
//
// El cobro y la activación ocurren en el Cloudflare Worker (ver cloudflare-worker/):
//   · GET  /paypal/config        -> clientId público, precio y moneda
//   · POST /paypal/create-order  -> crea la orden ligada al uid de quien está logueado
//   · POST /paypal/capture-order -> cobra, verifica con PayPal y escribe plan:"premium"
// Este módulo solo muestra el modal con los botones de PayPal y llama a esos endpoints
// con el ID token de Firebase Auth. El navegador nunca decide si "se pagó".

import { TRIAL_WORKER_BASE } from "./trial.js";

const WHATSAPP = "https://wa.me/56945984570?text=Hola%2C%20quiero%20pasarme%20a%20Premium%20en%20AulaGame.";

let styleInjected = false;
function injectStyle() {
  if (styleInjected) return;
  styleInjected = true;
  const st = document.createElement("style");
  st.textContent = `
    .pp-overlay{position:fixed;inset:0;background:rgba(10,10,20,.62);z-index:99995;display:flex;align-items:center;justify-content:center;padding:16px;font-family:system-ui,sans-serif}
    .pp-modal{background:#fff;color:#1c2233;border-radius:18px;max-width:420px;width:100%;padding:24px;box-shadow:0 14px 44px rgba(0,0,0,.4);max-height:94vh;overflow:auto}
    .pp-modal h3{margin:0 0 6px;font-size:21px}
    .pp-price{font-size:34px;font-weight:800;margin:6px 0 2px}
    .pp-price small{font-size:14px;font-weight:600;color:#667}
    .pp-list{margin:12px 0 16px;padding:0;list-style:none;font-size:14px;line-height:1.7}
    .pp-msg{font-size:14px;margin:10px 0;min-height:1.2em}
    .pp-err{color:#b3261e}.pp-ok{color:#1b7f45;font-weight:700}
    .pp-actions{display:flex;gap:10px;justify-content:flex-end;margin-top:14px;flex-wrap:wrap}
    .pp-btn{padding:10px 18px;border-radius:10px;border:none;font-weight:700;font-size:14px;cursor:pointer;text-decoration:none;display:inline-block}
    .pp-btn-ghost{background:#eee;color:#333}.pp-btn-wa{background:#25D366;color:#08321c}
  `;
  document.head.appendChild(st);
}

function cargarSdkPayPal(clientId, currency) {
  if (window.paypal && window.paypal.Buttons) return Promise.resolve(window.paypal);
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://www.paypal.com/sdk/js?client-id=" + encodeURIComponent(clientId) +
      "&currency=" + encodeURIComponent(currency) + "&intent=capture&components=buttons&disable-funding=credit,paylater";
    s.onload = () => (window.paypal && window.paypal.Buttons ? resolve(window.paypal) : reject(new Error("PayPal no cargó.")));
    s.onerror = () => reject(new Error("No se pudo cargar PayPal. Revisa tu conexión."));
    document.head.appendChild(s);
  });
}

async function postWorker(path, idToken, body) {
  const res = await fetch(TRIAL_WORKER_BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + idToken },
    body: JSON.stringify(body || {}),
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok || !payload || !payload.ok) {
    const err = new Error((payload && payload.error) || "No se pudo completar la operación. Intenta de nuevo.");
    err.code = payload && payload.code;
    throw err;
  }
  return payload;
}

/**
 * Abre el modal de compra. options:
 *   getIdToken()  — Promise<string> con el ID token de Firebase del profe logueado
 *   onPremium()   — se llama cuando el servidor confirmó el pago y activó el plan
 */
export function abrirCompraPremium(options) {
  injectStyle();
  const overlay = document.createElement("div");
  overlay.className = "pp-overlay";
  overlay.innerHTML = `
    <div class="pp-modal" role="dialog" aria-modal="true" aria-label="Comprar AulaGame Premium">
      <h3>⭐ AulaGame Premium</h3>
      <div class="pp-price" id="pp-price">…</div>
      <ul class="pp-list">
        <li>✅ Pago único, <b>de por vida</b> (sin mensualidades)</li>
        <li>✅ Juegos ilimitados en tu cuenta</li>
        <li>✅ Preguntas con IA integrada</li>
        <li>✅ Se activa automáticamente en esta cuenta</li>
      </ul>
      <div id="pp-buttons"></div>
      <div class="pp-msg" id="pp-msg"></div>
      <div class="pp-actions">
        <a class="pp-btn pp-btn-wa" id="pp-wa" href="${WHATSAPP}" target="_blank" rel="noopener" style="display:none">💬 Escríbenos por WhatsApp</a>
        <button type="button" class="pp-btn pp-btn-ghost" id="pp-close">Cerrar</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const $ = (id) => overlay.querySelector("#" + id);
  const msg = (t, cls) => { const m = $("pp-msg"); m.textContent = t || ""; m.className = "pp-msg" + (cls ? " " + cls : ""); };
  const close = () => overlay.remove();
  $("pp-close").onclick = close;
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

  (async () => {
    let cfg;
    try {
      const res = await fetch(TRIAL_WORKER_BASE + "/paypal/config");
      cfg = await res.json();
      if (!res.ok || !cfg.ok) throw new Error(cfg && cfg.error);
    } catch (e) {
      $("pp-price").textContent = "";
      msg((e && e.message) || "El pago en línea todavía no está disponible.", "pp-err");
      $("pp-wa").style.display = "inline-block";
      return;
    }
    $("pp-price").innerHTML = cfg.currency + " " + cfg.price + " <small>pago único</small>";
    try {
      const paypal = await cargarSdkPayPal(cfg.clientId, cfg.currency);
      paypal.Buttons({
        style: { layout: "vertical", shape: "pill", label: "pay", height: 46 },
        createOrder: async () => {
          msg("");
          const idToken = await options.getIdToken();
          const r = await postWorker("/paypal/create-order", idToken);
          return r.id;
        },
        onApprove: async (data) => {
          msg("Confirmando tu pago…");
          try {
            const idToken = await options.getIdToken();
            await postWorker("/paypal/capture-order", idToken, { orderID: data.orderID });
            $("pp-buttons").innerHTML = "";
            msg("🎉 ¡Pago recibido! Tu cuenta ya es Premium.", "pp-ok");
            if (options.onPremium) options.onPremium();
          } catch (e) {
            msg(e.message, "pp-err");
            $("pp-wa").style.display = "inline-block";
          }
        },
        onCancel: () => msg("Cancelaste el pago. No se hizo ningún cobro."),
        onError: (e) => {
          msg((e && e.message) || "Ocurrió un error con PayPal. Intenta de nuevo.", "pp-err");
          $("pp-wa").style.display = "inline-block";
        },
      }).render($("pp-buttons"));
    } catch (e) {
      msg(e.message, "pp-err");
      $("pp-wa").style.display = "inline-block";
    }
  })();
}
