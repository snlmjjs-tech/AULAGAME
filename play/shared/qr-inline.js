// Módulo compartido: pinta el QR de conexión ya visible (sin depender de un
// modal) en el menú principal de cada juego, reutilizando la misma sala que
// el botón "Conectar celulares" (crearSalaCacheada en live-room.js) para que
// ambos apunten siempre al mismo código.
import { crearSalaCacheada } from "./live-room.js";

/**
 * Crea (o reutiliza) la sala del juego y pinta el QR + link corto en todos
 * los contenedores indicados (ids de elemento o el elemento mismo). Puede
 * llamarse más de una vez (ej. una vez para el QR del menú y otra al abrir
 * el modal de detalle) sin crear salas duplicadas.
 * Devuelve { sala, codigoCorto, joinUrl } o null si falló (sin conexión).
 */
export async function pintarQR({ juego, destino, contenedores, links, tamano }){
  try{
    const { sala, codigoCorto } = await crearSalaCacheada(juego, destino);
    const joinUrl = location.origin + destino + "?room=" + sala;
    const textoLink = codigoCorto ? (location.host + "/" + codigoCorto) : joinUrl.replace(/^https?:\/\//, "");
    (contenedores || []).forEach(function(ref){
      const el = typeof ref === "string" ? document.getElementById(ref) : ref;
      if(!el) return;
      el.innerHTML = "";
      if(window.QRCode){
        new QRCode(el, { text: joinUrl, width: tamano || 140, height: tamano || 140, colorDark: "#1c2850", colorLight: "#ffffff", correctLevel: QRCode.CorrectLevel.M });
      }
    });
    (links || []).forEach(function(ref){
      const el = typeof ref === "string" ? document.getElementById(ref) : ref;
      if(el) el.textContent = "🔗 " + textoLink;
    });
    return { sala: sala, codigoCorto: codigoCorto, joinUrl: joinUrl };
  }catch(e){
    console.error("No se pudo generar el QR:", e);
    return null;
  }
}
