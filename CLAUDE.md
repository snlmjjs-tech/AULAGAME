# AULAGAME

Plataforma de juegos didácticos para profes ("duplica, personaliza y juega en clase").
Sitio público: **https://aulagame.cl** (único dominio activo; `aulagames.teacherseba.com`
es el dominio viejo y solo existe para redirigir a aulagame.cl, ver más abajo).

## Estructura de carpetas

- `index.html` — landing / catálogo de juegos.
- `r.html` — resuelve links cortos de sala (`aulagame.cl/<codigo>`, rewrite en `firebase.json`)
  leyendo `codigosCortos/{codigo}` en Firestore y redirigiendo al juego/sala real.
- `404.html` — página de error, también usada por GitHub Pages en el dominio viejo.
- `play/<juego>/index.html` — cada juego es una app de una sola página (HTML+CSS+JS inline,
  sin build step). Carpetas actuales: `agrupados`, `battlecastle3d`, `betyouranswer`, `bingo`,
  `colgado`, `evilgame`, `impostor`, `jeopardy`, `memorice`, `millonario`, `monopoly`,
  `quizlive`, `raceboard`, `robotfight`, `rosco`, `hotdogrun` (menú + `offline.html` + `online.html`; el modo online usa Supabase, no Firebase; `play/berryrun/` solo redirige a `hotdogrun`).
- `play/shared/*.js` — módulos JS compartidos entre juegos: `ai-questions.js` (llama al Worker
  de IA), `game-storage.js` (guardar/cargar preguntas en Firestore), `live-room.js` (salas en
  vivo con Realtime Database), `premium-status.js`, `qr-inline.js`, `short-links.js`,
  `trial.js` (demo Premium), `tutorial-modal.js`, `youtube.js`.
- `firebase-config.js` — config pública del SDK de Firebase (no es secreto, es normal que esté
  en el repo: las claves `apiKey` de Firebase Web son públicas por diseño).
- `intranet/` — mini-sitio aparte (otro hosting target de Firebase, `aulagame-intranet`), no
  tiene relación con el catálogo de juegos.
- `cloudflare-worker/` — Worker de Cloudflare que genera preguntas con IA y activa la demo
  Premium (ver abajo).
- `firestore.rules`, `database.rules.json`, `firestore.indexes.json` — reglas de seguridad.
- `.github/workflows/` — despliegue automático a Firebase Hosting (ver abajo).

## Plan gratis, Premium y demo

- Cada profesor es un documento `profes/{uid}` en Firestore, con un campo `plan`
  (`"gratis"` o `"premium"`). El campo `plan` **nunca** lo puede escribir el cliente directamente
  (ver `firestore.rules`): se activa a mano desde la consola de Firebase, o automáticamente por
  el Worker de Cloudflare al activar la demo.
- **Demo Premium**: 3 días de Premium gratis, una sola vez por cuenta. La activa el Worker
  (`POST /start-trial`, verificado con el ID token de Firebase Auth) escribiendo
  `trialUsado`, `trialFin`, `trialInicio` — estos campos tampoco los puede tocar el cliente
  directamente, solo el Worker (que usa una cuenta de servicio y no pasa por las reglas de
  cliente).
- **Generación de preguntas con IA**: solo para profes con plan Premium o demo activa
  (verificado en el servidor, en el Worker, nunca confiando en lo que mande el navegador).
  Límite de la demo: 10 usos de IA (`TRIAL_AI_LIMITE` en `cloudflare-worker/src/index.js`).
- La lista de juegos guardados de cada profe vive en `profes/{uid}/datosJuegos/{gameId}` — ver
  advertencia abajo, nunca se debe recortar ni sobrescribir completa.

## Dónde están los datos

- **Firestore** (`aulagame-4c019`):
  - `profes/{uid}` — datos del profesor (plan, trial, etc.).
  - `profes/{uid}/datosJuegos/{gameId}` — contenido editable de cada juego (preguntas, rondas,
    configuración), uno por juego, sincronizado entre dispositivos.
  - `codigosCortos/{codigo}` — links cortos (`aulagame.cl/<codigo>`) que resuelve `r.html`.
  - `profes/{uid}/datosJuegos/hotdogrun` y `hotdogrun_<c>` — preguntas de Hot Dog Run (la copia original y
    cada duplicado, `?c=<id>` en la URL), sincronizadas entre dispositivos.
  - `usosJuegos/{uid}` — contador de usos de Hot Dog Run del plan gratis (`hotdogUsos`, `hotdogUltimoUso`).
    Solo lo lee/escribe el Worker (`POST /hotdog/use`); las reglas de Firestore no lo exponen al cliente.
    Plan gratis: 5 usos (`HOTDOG_FREE_USOS` en `wrangler.toml`; repeticiones en 90 min no recuentan) y un solo
    duplicado de Hot Dog Run; Premium: ilimitado.
  - Hot Dog Run, botón CHEAT (solo administradores, código `2179` = `TEST_CODE` en `online.html`): al crear la sala
    agrega N bots; cada bot es un iframe invisible de `online.html?sala=<código>&bot=1` que entra como alumno y
    juega solo con la IA de bots del motor (sirve para probar el juego sin tener alumnos conectados).
    Con CHEAT activo, dentro de la sala hay "🛡 Entrar como supervisor": abre `online.html?sala=<código>&sup=1`, que
    vuelve a pedir el código `2179`; el supervisor juega sin responder preguntas, escribe mensajes de texto que ven todos
    (burbuja + aviso) y no cuenta en puntajes ni en "todos terminaron". El código es solo un freno en el cliente,
    no una barrera de seguridad real.
  - Hot Dog Run, sala de espera: chat de texto entre alumnos y profe (solo en la sala de espera; el profe lo silencia/activa;
    el anfitrión retransmite y limita 1 mensaje/s por alumno). La IA usa la config `hotdogrun` del Worker (hasta 45
    preguntas, ~5 por nivel; `maxCount` configurable en `play/shared/ai-questions.js`).
  - `tareas/{id}` — copias de juegos que un profe Premium (o en demo) envía a estudiantes (link para jugar solo en
    casa, p. ej. desde Classroom). Solo el Worker la lee y escribe (`POST /task/create`, `GET /task/get?id=`); las reglas
    de Firestore no la exponen. Juegos con esta opción (`TASK_GAMES` en el Worker, cada uno con su validador): `hotdogrun`
    (`offline.html?tarea=<id>`, contra bots), `millonario`, `colgado` y `memorice`, `rosco`, `quizlive` y `jeopardy` (`index.html?tarea=<id>`; Jeopardy solo contra 3 bots, el alumno marca "la sabía"/"no la sabía"; QuizLive juega solo contra bots que aparecen en el ranking y no incluye las preguntas de respuesta larga, un solo jugador; el Rosco es de autoevaluación porque solo guarda pistas). El estudiante
    entra sin cuenta. Botón del profe: `play/shared/task-share.js` (`abrirCompartirTarea`) en Millonario y Colgado.
  - `clasesIngles/{claseId}` — contenido de la intranet de inglés (sin Firebase Auth real ahí).
- **Realtime Database** — salas en vivo (`salasVivo/{juego}/{sala}/...`): jugadores, equipos,
  buzz, respuestas, estado de la partida en tiempo real. También `pines/{pin}` para resolver PIN
  → sala.
- **Cloudflare Worker** (`cloudflare-worker/`) — intermediario seguro para la API de Anthropic
  (Claude) y para activar la demo Premium; nunca expone la API key de Anthropic al navegador.

## Cómo se despliega cada parte

- **Hosting (aulagame.cl)** — automático: cada push o merge a `main` en GitHub despliega solo el
  hosting del target `main` (sitio `aulagame-4c019`) vía GitHub Actions
  (`.github/workflows/firebase-hosting-merge.yml`). Cada Pull Request genera un canal de vista
  previa (`firebase-hosting-pull-request.yml`). No hace falta correr `firebase deploy` a mano
  para esto. El target `intranet` (sitio `aulagame-intranet`) **no** se toca con este workflow.
- **Reglas de seguridad** (Firestore + Realtime Database) — manual:
  ```
  firebase deploy --only firestore:rules,database
  ```
  No hay automatización para esto a propósito (ver advertencia abajo).
- **Worker de Cloudflare** — manual, desde `cloudflare-worker/`:
  ```
  npx wrangler deploy
  ```

## Secretos

Los secretos (clave de la API de Anthropic, cuenta de servicio de Firebase para el Worker) viven
**solo en Cloudflare** (`npx wrangler secret put ...`, ver `cloudflare-worker/README.md`) y nunca
en este repositorio ni en archivos de configuración versionados. La única credencial en el repo
relacionada con despliegues es el secreto de GitHub Actions `FIREBASE_SERVICE_ACCOUNT_AULAGAME_4C019`,
que vive cifrado en GitHub (Settings → Secrets → Actions) y solo tiene permisos de Firebase Hosting
(no toca Firestore/Realtime Database rules ni el Worker).

## Advertencias

- **Nunca recortar ni sobrescribir completa** la lista de juegos guardados de un profesor
  (`profes/{uid}/datosJuegos/*`). Siempre leer lo existente y mezclar/actualizar por `gameId`,
  nunca reemplazar la colección entera.
- **No tocar `firestore.rules` ni `database.rules.json` sin avisar** al dueño del proyecto antes
  de desplegarlas (`firebase deploy --only firestore:rules,database`), aunque el cambio parezca
  pequeño: son las que protegen el plan Premium, la demo y los datos de cada profesor.
- **Los cambios van siempre a `main`** (el dueño lo pidió explícitamente): hacer commit y push
  directo a `main` (o PR y merge inmediato), para que se publiquen en aulagame.cl sin pasos extra.
