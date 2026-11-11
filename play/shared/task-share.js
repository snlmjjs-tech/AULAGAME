// Módulo compartido: "Enviar a estudiantes". Abre un cuadro donde el profe (Premium) crea un link para que
// cada estudiante juegue solo, en su casa, con el contenido que armó (p. ej. compartido por Google Classroom).
// El Worker guarda una copia del contenido (POST /task/create) y devuelve un id; el link abre el juego en modo "tarea".
//
//   abrirCompartirTarea({ game, defaultTitle, getData, studentPath })
//     game         — clave del juego aceptada por el Worker (TASK_GAMES)
//     defaultTitle — nombre sugerido de la tarea
//     getData()    — devuelve el contenido a guardar (la forma depende del juego)
//     studentPath  — ruta del juego para estudiantes, ej. "/play/colgado/"

import { firebaseConfig } from "../../firebase-config.js";
import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { TRIAL_WORKER_BASE } from "./trial.js";

const auth = getAuth(getApps().length ? getApp() : initializeApp(firebaseConfig));

let styled = false;
function injectStyle() {
  if (styled) return;
  styled = true;
  const st = document.createElement("style");
  st.textContent = `
    .ts-ov{position:fixed;inset:0;background:rgba(10,10,20,.62);z-index:99996;display:flex;align-items:center;justify-content:center;padding:16px;font-family:system-ui,sans-serif}
    .ts-box{background:#fff;color:#1c2233;border-radius:16px;max-width:440px;width:100%;padding:22px;box-shadow:0 14px 44px rgba(0,0,0,.4);max-height:94vh;overflow:auto}
    .ts-box h3{margin:0 0 6px;font-size:20px}.ts-box p{margin:0 0 12px;font-size:13.5px;color:#556;line-height:1.45}
    .ts-box label{display:block;font-size:13px;font-weight:700;margin:10px 0 4px}
    .ts-box input{width:100%;box-sizing:border-box;padding:10px 12px;border:1.5px solid #ccd;border-radius:9px;font-size:15px}
    .ts-err{color:#b3261e;font-size:13px;min-height:1.2em;margin:8px 0 0}.ts-err a{color:#5b3fd6;font-weight:700}
    .ts-row{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;margin-top:14px}
    .ts-b{padding:10px 16px;border-radius:9px;border:none;font-weight:700;font-size:14px;cursor:pointer;text-decoration:none;display:inline-block;background:#7c5cff;color:#fff}
    .ts-b.g{background:#eee;color:#333}.ts-b:disabled{opacity:.6;cursor:default}.ts-b.c{background:#1a73e8}
  `;
  document.head.appendChild(st);
}

async function crear(game, title, data) {
  await auth.authStateReady();
  const u = auth.currentUser;
  if (!u) return { ok: false, code: "NO_LOGIN" };
  try {
    const token = await u.getIdToken();
    const res = await fetch(TRIAL_WORKER_BASE + "/task/create", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify({ game, title, data }),
    });
    const j = await res.json().catch(() => null);
    return j && typeof j === "object" ? j : { ok: false, error: "No se pudo crear el link. Intenta de nuevo." };
  } catch (e) {
    return { ok: false, error: "No hay conexión. Revisa tu internet e intenta de nuevo." };
  }
}

export function abrirCompartirTarea({ game, defaultTitle, getData, studentPath }) {
  injectStyle();
  const ov = document.createElement("div");
  ov.className = "ts-ov";
  ov.innerHTML = `<div class="ts-box" role="dialog" aria-modal="true" aria-label="Enviar a estudiantes">
    <h3>📚 Enviar a estudiantes</h3>
    <p id="ts-p">Crea un link para que cada estudiante juegue solo en su casa, con tu contenido. Sin sala y sin cuenta. Puedes compartirlo en Google Classroom. Función Premium. Se guarda una copia de lo que tienes ahora: si lo cambias después, crea un link nuevo.</p>
    <div id="ts-form"><label for="ts-title">Nombre de la tarea</label><input id="ts-title" maxlength="80" placeholder="Ej: Repaso 7°A"></div>
    <div id="ts-out" hidden><label for="ts-link">Link para tus estudiantes</label><input id="ts-link" readonly>
      <div class="ts-row" style="justify-content:flex-start"><button class="ts-b g" id="ts-copy" type="button">Copiar link</button><a class="ts-b c" id="ts-class" target="_blank" rel="noopener">Compartir en Classroom</a></div></div>
    <div class="ts-err" id="ts-err" role="alert"></div>
    <div class="ts-row"><button class="ts-b g" id="ts-close" type="button">Cerrar</button><button class="ts-b" id="ts-go" type="button">Crear link</button></div></div>`;
  document.body.appendChild(ov);
  const $ = (id) => ov.querySelector("#" + id);
  const close = () => ov.remove();
  $("ts-close").onclick = close;
  ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
  $("ts-title").value = defaultTitle || "";
  $("ts-title").focus();
  $("ts-go").onclick = async () => {
    const err = $("ts-err"), btn = $("ts-go");
    err.textContent = "";
    let data;
    try { data = getData(); } catch (e) { data = null; }
    if (!data) { err.textContent = "No hay contenido para enviar. Agrega preguntas o palabras primero."; return; }
    btn.disabled = true; btn.textContent = "Creando…";
    const title = $("ts-title").value.trim();
    const r = await crear(game, title, data);
    if (!r.ok) {
      btn.disabled = false; btn.textContent = "Crear link";
      if (r.code === "NO_LOGIN") err.innerHTML = 'Inicia sesión en <a href="/?login=1" target="_blank" rel="noopener">aulagame.cl</a> para crear links.';
      else if (r.code === "NOT_PREMIUM") err.innerHTML = 'Esta función es de Premium. <a href="/?premium=1" target="_blank" rel="noopener">Hazte Premium</a> para enviar juegos a tus estudiantes.';
      else err.textContent = r.error || "No se pudo crear el link. Intenta de nuevo.";
      return;
    }
    const link = location.origin + studentPath + "?tarea=" + r.id;
    $("ts-link").value = link;
    $("ts-class").href = "https://classroom.google.com/share?url=" + encodeURIComponent(link) + "&title=" + encodeURIComponent(title || "Tarea de AulaGame");
    $("ts-form").hidden = true; $("ts-out").hidden = false; btn.hidden = true;
    $("ts-p").textContent = "¡Listo! Pega este link en Classroom, WhatsApp o donde quieras. Cada estudiante juega solo, sin sala ni cuenta.";
    $("ts-copy").onclick = () => {
      $("ts-link").select();
      const ok = () => { $("ts-copy").textContent = "¡Copiado!"; setTimeout(() => ($("ts-copy").textContent = "Copiar link"), 1600); };
      try { navigator.clipboard.writeText(link).then(ok, () => { document.execCommand("copy"); ok(); }); } catch (e) { document.execCommand("copy"); ok(); }
    };
  };
}
