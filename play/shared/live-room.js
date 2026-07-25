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
 * Registro global de PINes (independiente de `juego`, nodo "pines" al tope de
 * la base de datos) — permite que la página principal reciba solo un PIN
 * numérico (sin saber a qué juego pertenece) y lo resuelva con una sola
 * lectura pública, en vez de tener que revisar salasVivo/<juego>/<pin> juego
 * por juego. Lectura pública, escritura solo autenticada (ver database.rules.json).
 */
function refPin(pin){ return ref(db, "pines/" + pin); }

/**
 * Crea una sala nueva para `juego` en Realtime Database y su link corto
 * asociado (Firestore, colección codigosCortos — ver short-links.js).
 * El código de sala es único a nivel global (no solo dentro de `juego`), para
 * que el mismo PIN nunca apunte a dos juegos distintos.
 * Devuelve { sala, codigoCorto }. codigoCorto puede ser null si falló al
 * generarse (sin conexión) — no bloqueante, el QR/código de sala igual sirven.
 */
export async function crearSala(juego, destino){
  let sala = null;
  for(let intento = 0; intento < 5; intento++){
    const candidato = generarCodigoSala();
    const [snapPin, snapMeta] = await Promise.all([
      get(refPin(candidato)),
      get(refSala(juego, candidato, "meta"))
    ]);
    if(!snapPin.exists() && !snapMeta.exists()){ sala = candidato; break; }
  }
  if(!sala) throw new Error("No se pudo generar un código de sala único");

  const destinoFinal = destino || ("/play/" + juego + "/");

  await Promise.all([
    set(refSala(juego, sala, "meta"), { creadoEn: serverTimestamp() }),
    set(refPin(sala), { juego: juego, destino: destinoFinal, paramNombre: "room", creadoEn: serverTimestamp() })
  ]);

  const codigoCorto = await crearCodigoCorto({
    juego: juego,
    destino: destinoFinal,
    paramNombre: "room",
    paramValor: sala
  });

  return { sala: sala, codigoCorto: codigoCorto };
}

/**
 * Registra un PIN generado por un juego que NO usa crearSala() de este mismo
 * módulo (ej. QuizLive tiene su propia base de datos separada; Battle Castle
 * 3D usa PeerJS sin base de datos) — para que igual aparezca en el registro
 * global y la página principal pueda redirigir con solo el PIN.
 */
export async function registrarPinExterno(pin, juego, destino, paramNombre, extraQuery){
  const datos = {
    juego: juego,
    destino: destino,
    paramNombre: paramNombre || "room",
    creadoEn: serverTimestamp()
  };
  if(extraQuery) datos.extraQuery = extraQuery;
  await set(refPin(pin), datos);
}

export function escuchar(ref_, cb){
  return onValue(ref_, function(snap){ cb(snap.val()); });
}
export function escribir(ref_, datos){ return set(ref_, datos); }
export function actualizar(ref_, datos){ return update(ref_, datos); }
export function eliminar(ref_){ return remove(ref_); }
export function marcaTiempo(){ return serverTimestamp(); }

const cacheSalas = {}; // "juego:destino" -> Promise<{sala, codigoCorto}>

/**
 * Igual que crearSala, pero cachea la Promise por juego+destino dentro de la
 * misma carga de página: llamarla varias veces (ej. desde el QR visible del
 * menú y luego desde el botón "Conectar celulares") reutiliza la misma sala
 * en vez de crear una nueva cada vez.
 */
export function crearSalaCacheada(juego, destino){
  const clave = juego + ":" + (destino || "");
  if(!cacheSalas[clave]) cacheSalas[clave] = crearSala(juego, destino);
  return cacheSalas[clave];
}

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
