// Módulo compartido: sala en vivo por Realtime Database para el modo QR
// "solo jugar" de los juegos de mesa (Rosco, Millonario, Impostor, etc.).
// El profesor crea la sala y publica el estado público de la partida; los
// alumnos se conectan sin cuenta (vía ?room=XXXXXX) y solo leen/escriben en
// su propio nodo. El link corto (aulagame.cl/H0799) se genera automáticamente
// reutilizando el sistema de short-links.js.
import { firebaseConfig } from "../../firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getDatabase, ref, set, update, remove, onValue, get, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js";
import { crearCodigoCorto } from "./short-links.js";

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

function generarCodigoSala(){
  return String(Math.floor(100000 + Math.random() * 900000));
}

export function refSala(juego, sala, path){
  return ref(db, "salasVivo/" + juego + "/" + sala + (path ? "/" + path : ""));
}

/**
 * Crea una sala nueva para `juego` en Realtime Database y su link corto
 * asociado (Firestore, colección codigosCortos — ver short-links.js).
 * Devuelve { sala, codigoCorto }. codigoCorto puede ser null si falló al
 * generarse (sin conexión) — no bloqueante, el QR/código de sala igual sirven.
 */
export async function crearSala(juego, destino){
  let sala = null;
  for(let intento = 0; intento < 5; intento++){
    const candidato = generarCodigoSala();
    const snap = await get(refSala(juego, candidato, "meta"));
    if(!snap.exists()){ sala = candidato; break; }
  }
  if(!sala) throw new Error("No se pudo generar un código de sala único");

  await set(refSala(juego, sala, "meta"), { creadoEn: serverTimestamp() });

  const codigoCorto = await crearCodigoCorto({
    juego: juego,
    destino: destino || ("/play/" + juego + "/"),
    paramNombre: "room",
    paramValor: sala
  });

  return { sala: sala, codigoCorto: codigoCorto };
}

export function escuchar(ref_, cb){
  return onValue(ref_, function(snap){ cb(snap.val()); });
}
export function escribir(ref_, datos){ return set(ref_, datos); }
export function actualizar(ref_, datos){ return update(ref_, datos); }
export function eliminar(ref_){ return remove(ref_); }
export function marcaTiempo(){ return serverTimestamp(); }

/** Id estable por sala para este dispositivo/pestaña — sobrevive recargas de página. */
export function idJugador(sala){
  const key = "aulagame_jugador_" + sala;
  let id = sessionStorage.getItem(key);
  if(!id){
    id = (crypto.randomUUID ? crypto.randomUUID() : (String(Date.now()) + Math.random().toString(16).slice(2)));
    sessionStorage.setItem(key, id);
  }
  return id;
}
