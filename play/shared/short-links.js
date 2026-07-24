// Módulo compartido: genera y guarda links cortos (ej. aulagame.cl/H0799)
// que apuntan a una sala/PIN de un juego en vivo, para que el profesor no
// tenga que compartir la URL larga. Vive en el proyecto Firebase principal
// (Firestore, colección "codigosCortos"), sea cual sea la base de datos que
// use el juego en sí para sincronizar la partida.
import { firebaseConfig } from "../../firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getFirestore, doc, getDoc, setDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// Sin I/O para no confundir con 1/0 al leerlo en voz alta o escribirlo a mano.
const LETRAS = "ABCDEFGHJKLMNPQRSTUVWXYZ";

function generarCandidato(){
  var letra = LETRAS.charAt(Math.floor(Math.random() * LETRAS.length));
  var digitos = String(Math.floor(Math.random() * 10000)).padStart(4, "0");
  return letra + digitos;
}

// Evita crear un código nuevo cada vez que el profe reabre el modal del QR
// para la misma sala: mientras el paramValor no cambie, se reusa el mismo.
var cache = {}; // paramValor -> codigo

/**
 * Crea (o reutiliza) un código corto para una sala/PIN y lo guarda en
 * Firestore. Devuelve una Promise<string|null> — null si falló (ej. sin
 * conexión); el llamador debe tratarlo como "no bloqueante": el QR/link
 * largo ya funcionan igual sin el código corto.
 */
export async function crearCodigoCorto({ juego, destino, paramNombre, paramValor, extraQuery }){
  var clave = juego + ":" + paramValor;
  if(cache[clave]) return cache[clave];

  try{
    for(var intento = 0; intento < 5; intento++){
      var candidato = generarCandidato();
      var ref = doc(db, "codigosCortos", candidato);
      var snap = await getDoc(ref);
      if(snap.exists()) continue;

      var datos = {
        juego: juego,
        destino: destino,
        paramNombre: paramNombre,
        paramValor: paramValor,
        creadoEn: serverTimestamp()
      };
      if(extraQuery) datos.extraQuery = extraQuery;

      await setDoc(ref, datos);
      cache[clave] = candidato;
      return candidato;
    }
    return null;
  }catch(e){
    console.error("No se pudo crear el link corto:", e);
    return null;
  }
}
