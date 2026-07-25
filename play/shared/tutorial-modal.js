// Módulo compartido: tutorial breve de "cómo se juega" que aparece solo la
// primera vez que se entra a un juego (por rol — profesor o alumno — y por
// dispositivo, vía localStorage), tanto en el modo normal como en el modo QR.
const PREFIJO = "aulagame_tutorial_";

function construirModal(){
  let modal = document.getElementById("aulagame-tutorial-modal");
  if(modal) return modal;
  modal = document.createElement("div");
  modal.id = "aulagame-tutorial-modal";
  modal.style.cssText = "position:fixed;inset:0;background:rgba(8,10,24,.78);display:none;align-items:center;justify-content:center;z-index:99999;padding:18px;font-family:system-ui,-apple-system,sans-serif;";
  document.body.appendChild(modal);
  return modal;
}

/** Muestra el tutorial sin importar si ya se vio antes (ej. botón "¿Cómo se juega?"). */
export function mostrarTutorial(clave, opciones){
  const modal = construirModal();
  const titulo = (opciones && opciones.titulo) || "¿Cómo se juega?";
  const pasos = (opciones && opciones.pasos) || [];
  modal.innerHTML =
    '<div style="background:#fff;color:#1c2850;max-width:440px;width:100%;border-radius:18px;padding:26px;box-shadow:0 12px 44px rgba(0,0,0,.45);max-height:86vh;overflow:auto;">'
    + '<h2 style="margin:0 0 14px;font-size:21px;">' + titulo + '</h2>'
    + '<ul style="margin:0 0 20px;padding-left:22px;line-height:1.55;font-size:15px;">'
    + pasos.map(function(p){ return "<li>" + p + "</li>"; }).join("")
    + '</ul>'
    + '<button id="aulagame-tutorial-close" style="width:100%;padding:13px;border:none;border-radius:11px;background:#1c2850;color:#fff;font-weight:700;font-size:15px;cursor:pointer;">¡Entendido, a jugar! 🎮</button>'
    + '</div>';
  modal.style.display = "flex";
  document.getElementById("aulagame-tutorial-close").addEventListener("click", function(){
    modal.style.display = "none";
    try{ localStorage.setItem(PREFIJO + clave, "1"); }catch(e){}
    if(opciones && opciones.alCerrar) opciones.alCerrar();
  });
}

/** Igual que mostrarTutorial, pero solo la primera vez (según localStorage) para esta clave. */
export function mostrarTutorialSiPrimeraVez(clave, opciones){
  try{ if(localStorage.getItem(PREFIJO + clave)) return; }catch(e){}
  mostrarTutorial(clave, opciones);
}
