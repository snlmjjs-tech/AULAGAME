// Módulo compartido: generación de preguntas con IA (Claude, vía Cloudflare Worker
// propio), disponible solo para profesores con plan Premium (`profes/{uid}.plan`).
//
// Uso típico desde el editor de un juego:
//
//   import { renderAIButton } from "../shared/ai-questions.js";
//   renderAIButton(document.getElementById("mi-toolbar"), {
//     uid: CURRENT_UID,
//     game: "raceboard",
//     defaultCount: 12,
//     onGenerated(data) { /* data.questions, data.rounds, etc. según el juego — ver Worker */ }
//   });
//
// El botón se auto-actualiza: mientras se resuelve el plan del profesor no muestra nada,
// luego muestra "✨ Generar con IA" (premium) o "🔒 Función Premium" (gratis, con link a
// WhatsApp). Nunca guarda nada solo: siempre entrega las preguntas generadas a onGenerated
// para que el propio juego las vuelque en su editor y el profesor las revise antes de guardar.

import { firebaseConfig } from "../../firebase-config.js";
import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getFirestore, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

// Reemplaza esta URL por la que te entregue `wrangler deploy` (ver cloudflare-worker/README.md).
const AI_WORKER_URL = "https://aulagame-ai-questions.TU-SUBDOMINIO.workers.dev/generate";

export const PREMIUM_WHATSAPP_LINK =
  "https://wa.me/56945984570?text=Hola%2C%20quiero%20pasarme%20a%20Premium%20en%20AulaGame.";

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
const db = getFirestore(app);

const planCache = {}; // uid -> Promise<boolean>, evita repetir la consulta a Firestore

/** Devuelve true si profes/{uid}.plan === "premium". Cachea el resultado por uid. */
export function isPremiumTeacher(uid) {
  if (!uid) return Promise.resolve(false);
  if (!planCache[uid]) {
    planCache[uid] = getDoc(doc(db, "profes", uid))
      .then((snap) => (snap.exists() && snap.data().plan === "premium"))
      .catch(() => false);
  }
  return planCache[uid];
}

let modalStyleInjected = false;
function injectModalStyle() {
  if (modalStyleInjected) return;
  modalStyleInjected = true;
  const style = document.createElement("style");
  style.textContent = `
    .ai-q-overlay{position:fixed;inset:0;background:rgba(10,10,20,.6);z-index:99990;
      display:flex;align-items:center;justify-content:center;padding:16px;font-family:system-ui,sans-serif;}
    .ai-q-modal{background:#fff;color:#1c2233;border-radius:14px;max-width:420px;width:100%;
      padding:24px;box-shadow:0 12px 40px rgba(0,0,0,.35);}
    .ai-q-modal h3{margin:0 0 6px;font-size:19px;}
    .ai-q-modal p.ai-q-sub{margin:0 0 16px;font-size:13px;color:#666;}
    .ai-q-modal label{display:block;font-size:13px;font-weight:600;margin:12px 0 4px;}
    .ai-q-modal input[type=text],.ai-q-modal input[type=number]{width:100%;box-sizing:border-box;
      padding:10px 12px;border:1.5px solid #ccc;border-radius:8px;font-size:15px;}
    .ai-q-modal input:focus{outline:none;border-color:#7c5cff;}
    .ai-q-actions{display:flex;gap:10px;margin-top:20px;justify-content:flex-end;}
    .ai-q-btn{padding:10px 18px;border-radius:8px;border:none;font-weight:700;font-size:14px;cursor:pointer;}
    .ai-q-btn-primary{background:#7c5cff;color:#fff;}
    .ai-q-btn-primary:disabled{opacity:.6;cursor:default;}
    .ai-q-btn-ghost{background:#eee;color:#333;}
    .ai-q-error{color:#b3261e;font-size:13px;margin-top:10px;}
    .ai-q-spinner{display:inline-block;width:14px;height:14px;border:2px solid rgba(255,255,255,.5);
      border-top-color:#fff;border-radius:50%;animation:ai-q-spin .7s linear infinite;margin-right:8px;vertical-align:-2px;}
    @keyframes ai-q-spin{to{transform:rotate(360deg)}}
  `;
  document.head.appendChild(style);
}

/**
 * Abre el modal "tema + cantidad + generar" y llama al Worker. Devuelve una Promise que
 * resuelve con `data` (la estructura específica del juego) si el profesor generó preguntas
 * con éxito, o `null` si canceló.
 */
function openAIGeneratorModal({ uid, game, defaultCount, fixedCount, extraFields }) {
  injectModalStyle();
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "ai-q-overlay";
    overlay.innerHTML = `
      <div class="ai-q-modal">
        <h3>✨ Generar preguntas con IA</h3>
        <p class="ai-q-sub">Describe el tema y la IA generará las preguntas. Podrás revisarlas y editarlas antes de guardar.</p>
        <label for="ai-q-subject">Tema o materia</label>
        <input type="text" id="ai-q-subject" placeholder="Ej: Verbos irregulares en pasado, Capitales de Sudamérica..." maxlength="200">
        ${fixedCount ? "" : `
        <label for="ai-q-count">Cantidad de preguntas</label>
        <input type="number" id="ai-q-count" min="1" max="60" value="${defaultCount || 10}">
        `}
        ${extraFields || ""}
        <div class="ai-q-error" id="ai-q-error" style="display:none;"></div>
        <div class="ai-q-actions">
          <button class="ai-q-btn ai-q-btn-ghost" id="ai-q-cancel">Cancelar</button>
          <button class="ai-q-btn ai-q-btn-primary" id="ai-q-go">Generar</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const subjectInput = overlay.querySelector("#ai-q-subject");
    const countInput = overlay.querySelector("#ai-q-count");
    const errorBox = overlay.querySelector("#ai-q-error");
    const goBtn = overlay.querySelector("#ai-q-go");
    const cancelBtn = overlay.querySelector("#ai-q-cancel");
    subjectInput.focus();

    function close(result) {
      overlay.remove();
      resolve(result);
    }
    cancelBtn.addEventListener("click", () => close(null));
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(null); });

    goBtn.addEventListener("click", async () => {
      const subject = subjectInput.value.trim();
      if (!subject) {
        errorBox.textContent = "Escribe un tema para generar las preguntas.";
        errorBox.style.display = "block";
        return;
      }
      const count = fixedCount || (countInput ? parseInt(countInput.value, 10) || defaultCount : defaultCount);

      errorBox.style.display = "none";
      goBtn.disabled = true;
      cancelBtn.disabled = true;
      goBtn.innerHTML = '<span class="ai-q-spinner"></span> Generando...';

      try {
        const res = await fetch(AI_WORKER_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ uid, game, subject, count }),
        });
        const payload = await res.json().catch(() => null);
        if (!res.ok || !payload || !payload.ok) {
          throw new Error((payload && payload.error) || "No se pudo generar las preguntas. Intenta de nuevo.");
        }
        close(payload.data);
      } catch (e) {
        errorBox.textContent = e.message || "Ocurrió un error inesperado. Intenta de nuevo.";
        errorBox.style.display = "block";
        goBtn.disabled = false;
        cancelBtn.disabled = false;
        goBtn.textContent = "Generar";
      }
    });
  });
}

/**
 * Inserta en `container` el botón de generación con IA, ya resuelto según el plan del
 * profesor (premium: botón activo; gratis: botón con candado que invita a upgrade).
 *
 * options:
 *   uid          — uid del profesor (CURRENT_UID del juego)
 *   game         — clave del juego (debe existir en GAME_CONFIG del Worker)
 *   defaultCount — cantidad sugerida por defecto (ignorado si fixedCount)
 *   fixedCount   — si el juego tiene una cantidad fija (ej. rosco:26), pásala aquí
 *   label        — texto del botón activo (por defecto "✨ Generar con IA")
 *   className    — clases CSS a aplicar al <button> para que combine con el resto del juego
 *   onGenerated(data) — callback con las preguntas generadas, para volcarlas en el editor
 */
export function renderAIButton(container, options) {
  if (!container) return;
  const { uid, game, defaultCount, fixedCount, onGenerated, className, label } = options;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = className || "";
  btn.textContent = "⏳ Cargando...";
  btn.disabled = true;
  if (!className) {
    btn.style.cssText = "padding:9px 16px;border-radius:8px;border:none;background:#7c5cff;color:#fff;font-weight:700;cursor:pointer;font-size:14px;";
  }
  container.appendChild(btn);

  isPremiumTeacher(uid).then((premium) => {
    btn.disabled = false;
    if (premium) {
      btn.textContent = label || "✨ Generar con IA";
      btn.onclick = async () => {
        const data = await openAIGeneratorModal({ uid, game, defaultCount, fixedCount, extraFields: options.extraFields });
        if (data && onGenerated) onGenerated(data);
      };
    } else {
      btn.textContent = "🔒 Función Premium";
      if (!className) btn.style.background = "#8a8a8a";
      btn.onclick = () => {
        window.open(PREMIUM_WHATSAPP_LINK, "_blank", "noopener");
      };
    }
  });

  return btn;
}
