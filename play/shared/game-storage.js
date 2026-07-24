// Módulo compartido: guardado del contenido editable de cada juego (preguntas,
// rondas, configuración, etc.) en Firestore bajo la cuenta del profesor, para
// que sincronice entre dispositivos. localStorage se usa solo como respaldo
// temporal si falla la conexión, nunca como almacén principal.
import { firebaseConfig } from "../../firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

function backupKey(gameKey){ return "aulagame_backup_" + gameKey; }

function readBackup(gameKey){
  try{
    const raw = localStorage.getItem(backupKey(gameKey));
    return raw ? JSON.parse(raw) : null;
  }catch(e){ return null; }
}

function writeBackup(gameKey, data){
  try{ localStorage.setItem(backupKey(gameKey), JSON.stringify(data)); }
  catch(e){ /* localStorage puede fallar (incógnito, cuota); no es crítico */ }
}

let toastEl = null;
function toast(msg, isError){
  if(!toastEl){
    toastEl = document.createElement("div");
    toastEl.style.cssText = "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);"
      + "background:#1c2850;color:#fff;padding:10px 18px;border-radius:8px;font:600 14px/1.3 system-ui,sans-serif;"
      + "z-index:99999;box-shadow:0 4px 16px rgba(0,0,0,.3);opacity:0;transition:opacity .2s;pointer-events:none;max-width:88vw;text-align:center";
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.style.background = isError ? "#a33" : "#1c2850";
  toastEl.style.opacity = "1";
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(()=>{ toastEl.style.opacity = "0"; }, 3200);
}

async function fetchSavedData(gameKey, uid){
  let data = null;
  try{
    const snap = await getDoc(doc(db, "profes", uid, "datosJuegos", gameKey));
    if(snap.exists()){
      data = snap.data();
      writeBackup(gameKey, data);
    }
  }catch(e){
    data = readBackup(gameKey);
  }
  return data;
}

/**
 * Gate de sesión + carga inicial de los datos guardados del juego.
 * Revela la página y llama onReady(datosGuardados, uid) una vez resuelto.
 * datosGuardados es null si el profesor nunca ha guardado nada aún para este juego.
 */
export function initGameSync(gameKey, onReady){
  onAuthStateChanged(auth, async function(user){
    if(!user){ location.replace("/"); return; }
    const data = await fetchSavedData(gameKey, user.uid);
    document.documentElement.style.visibility = "";
    onReady(data, user.uid);
  });
}

/**
 * Igual que initGameSync pero sin gatear la sesión ni tocar la visibilidad de
 * la página — para juegos que ya manejan su propio auth-gate (ej. porque
 * también admiten un modo sin login, como un jugador uniéndose por QR).
 * Devuelve una Promise&lt;{saved, uid}&gt; que espera a que Firebase resuelva el
 * estado de sesión actual una sola vez (uid es null si no hay usuario logueado).
 */
export function loadGameData(gameKey){
  return new Promise(function(resolve){
    const unsubscribe = onAuthStateChanged(auth, async function(user){
      unsubscribe();
      if(!user){ resolve({ saved: null, uid: null }); return; }
      const data = await fetchSavedData(gameKey, user.uid);
      resolve({ saved: data, uid: user.uid });
    });
  });
}

const debounceTimers = {};

/**
 * Guarda el contenido editable del juego en Firestore (con respaldo local).
 * Devuelve una Promise&lt;boolean&gt; que indica si el guardado en la nube tuvo éxito
 * (aunque falle, la copia local de respaldo ya quedó escrita antes de intentar).
 */
export function saveGameData(gameKey, uid, data){
  writeBackup(gameKey, data);
  if(!uid) return Promise.resolve(false);
  try{
    return setDoc(doc(db, "profes", uid, "datosJuegos", gameKey), data)
      .then(function(){ return true; })
      .catch(function(err){
        console.error("No se pudo guardar en Firestore:", err);
        toast("⚠️ No se pudo guardar en la nube. Se guardó una copia local en este navegador — revisa tu conexión.", true);
        return false;
      });
  }catch(err){
    // setDoc puede lanzar de forma síncrona si los datos no son válidos
    // (ej. arrays anidados), no solo rechazar la promesa.
    console.error("No se pudo guardar en Firestore:", err);
    toast("⚠️ No se pudo guardar en la nube. Se guardó una copia local en este navegador — revisa tu conexión.", true);
    return Promise.resolve(false);
  }
}

/** Igual que saveGameData pero agrupa llamadas seguidas en una sola escritura. */
export function saveGameDataDebounced(gameKey, uid, data, delay){
  writeBackup(gameKey, data);
  clearTimeout(debounceTimers[gameKey]);
  return new Promise(function(resolve){
    debounceTimers[gameKey] = setTimeout(function(){
      resolve(saveGameData(gameKey, uid, data));
    }, delay || 600);
  });
}

export { toast };
