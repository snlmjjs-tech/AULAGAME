// Módulo compartido: manejo robusto de videos de YouTube para los juegos de
// AulaGame. Una sola función para sacar el ID desde cualquier formato de
// link, validar que se pueda incrustar, armar la URL de embed, y un
// reproductor que usa la IFrame Player API de YouTube con indicador de
// carga, tiempo máximo de espera y un botón "Abrir en YouTube" si falla.

const ID_RE = /^[A-Za-z0-9_-]{11}$/;

/** Saca el ID (11 caracteres) desde cualquier formato de link de YouTube
 * (watch?v=, youtu.be/, shorts/, embed/, live/, m.youtube.com, con &t= o
 * &list= extra) o desde el ID pegado solo. Devuelve null si no reconoce nada. */
export function parseYouTubeId(input){
  if(!input) return null;
  const s = String(input).trim();
  if(ID_RE.test(s)) return s;
  let url = null;
  try{ url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : 'https://'+s); }catch(e){}
  if(url){
    const host = url.hostname.toLowerCase().replace(/^www\.|^m\.|^music\./,'');
    if(host === 'youtu.be'){
      const id = url.pathname.split('/').filter(Boolean)[0];
      if(id && ID_RE.test(id)) return id;
    } else if(host === 'youtube.com' || host === 'youtube-nocookie.com'){
      const v = url.searchParams.get('v');
      if(v && ID_RE.test(v)) return v;
      const parts = url.pathname.split('/').filter(Boolean);
      const i = parts.findIndex(p => ['embed','shorts','live','v'].includes(p));
      if(i >= 0 && parts[i+1] && ID_RE.test(parts[i+1])) return parts[i+1];
    }
  }
  const m = s.match(/(?:youtu\.be\/|[?&]v=|\/embed\/|\/shorts\/|\/live\/|\/v\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

/** Saca segundos de inicio desde un link que ya trae &t=1m30s / &t=90 /
 * &start=90, para sugerir el inicio cuando el profesor pega un link así. */
export function parseStartSeconds(input){
  const s = String(input||'');
  let m = s.match(/[?&](?:t|start)=(\d+)(?!\w)/);
  if(m) return parseInt(m[1],10);
  m = s.match(/[?&]t=(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/);
  if(m && (m[1]||m[2]||m[3])) return (parseInt(m[1]||0,10)*3600)+(parseInt(m[2]||0,10)*60)+parseInt(m[3]||0,10);
  return null;
}

/** URL de embed (youtube-nocookie, sin cookies de seguimiento) con los
 * parámetros de inicio/fin ya resueltos. */
export function buildEmbedUrl(id, opts={}){
  const p = new URLSearchParams({ rel:'0', modestbranding:'1', playsinline:'1' });
  if(opts.start) p.set('start', String(Math.max(0, Math.floor(opts.start))));
  if(opts.end) p.set('end', String(Math.max(0, Math.floor(opts.end))));
  if(opts.autoplay) p.set('autoplay','1');
  if(opts.mute) p.set('mute','1');
  return `https://www.youtube-nocookie.com/embed/${id}?${p.toString()}`;
}

/** Valida contra el endpoint oEmbed de YouTube si el video existe y permite
 * incrustarse. "Best effort": si hay un error de red no bloqueamos al
 * profesor (el reproductor en vivo ya tiene su propio manejo de errores) —
 * devolvemos ok:'unknown'. Solo avisamos cuando YouTube responde
 * explícitamente que no se puede (privado/eliminado/inserción desactivada). */
export async function checkEmbeddable(id, timeoutMs=5000){
  try{
    const ctrl = new AbortController();
    const timer = setTimeout(()=>ctrl.abort(), timeoutMs);
    const url = 'https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent('https://www.youtube.com/watch?v='+id);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if(res.status === 401 || res.status === 403) return { ok:false, reason:'Ese video no permite reproducirse dentro de AulaGame (inserción desactivada)' };
    if(res.status === 400 || res.status === 404) return { ok:false, reason:'Ese video no existe, es privado o fue eliminado' };
    if(!res.ok) return { ok:'unknown' };
    const data = await res.json();
    return { ok:true, title: data && data.title };
  }catch(e){
    return { ok:'unknown' };
  }
}

let apiPromise = null;
function loadIframeAPI(){
  if(window.YT && window.YT.Player) return Promise.resolve(window.YT);
  if(apiPromise) return apiPromise;
  apiPromise = new Promise((resolve)=>{
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = function(){ if(prev) prev(); resolve(window.YT); };
    if(!document.querySelector('script[data-yt-iframe-api]')){
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.setAttribute('data-yt-iframe-api','1');
      document.head.appendChild(s);
    }
  });
  return apiPromise;
}

/**
 * Monta un reproductor robusto dentro de `mount` (elemento DOM vacío, se
 * reemplaza por el iframe de la API oficial de YouTube — por eso ya trae los
 * atributos allow/allowfullscreen correctos). Si la API no carga, el video
 * no está disponible, o se demora más de `timeoutMs`, muestra un aviso con
 * botón "Abrir en YouTube" en vez de dejar un recuadro vacío/negro.
 * opts: {start, end, timeoutMs, onReady, onError, onStateChange}
 * Devuelve { destroy() } — llamar al cambiar de pregunta/pantalla.
 */
export function mountYouTubePlayer(mount, id, opts={}){
  let destroyed = false, player = null, timeoutH = null;
  mount.innerHTML = '';
  mount.classList.add('yt-mount-box');
  const loading = document.createElement('div');
  loading.className = 'yt-loading';
  loading.innerHTML = '<span class="yt-spin"></span><span>Cargando video…</span>';
  const playerSlot = document.createElement('div');
  mount.appendChild(loading);
  mount.appendChild(playerSlot);

  function showFallback(){
    if(destroyed) return;
    clearTimeout(timeoutH);
    mount.innerHTML = `<div class="yt-fallback">
      <p>⚠️ No se pudo reproducir este video aquí.</p>
      <a class="btn small azul" href="https://www.youtube.com/watch?v=${id}" target="_blank" rel="noopener">▶ Abrir en YouTube</a>
    </div>`;
    if(opts.onError) opts.onError();
  }

  timeoutH = setTimeout(showFallback, opts.timeoutMs || 8000);

  loadIframeAPI().then(YT=>{
    if(destroyed) return;
    try{
      const vars = { rel:0, modestbranding:1, playsinline:1, origin: location.origin };
      if(opts.start) vars.start = Math.max(0, Math.floor(opts.start));
      if(opts.end) vars.end = Math.max(0, Math.floor(opts.end));
      player = new YT.Player(playerSlot, {
        videoId: id,
        playerVars: vars,
        events: {
          onReady(){
            clearTimeout(timeoutH);
            if(loading.parentNode) loading.remove();
            if(opts.onReady) opts.onReady();
          },
          onError(){ showFallback(); },
          onStateChange(e){ if(opts.onStateChange) opts.onStateChange(e); }
        }
      });
    }catch(e){ showFallback(); }
  }).catch(showFallback);

  return {
    destroy(){
      destroyed = true;
      clearTimeout(timeoutH);
      try{ player && player.destroy && player.destroy(); }catch(e){}
    }
  };
}
