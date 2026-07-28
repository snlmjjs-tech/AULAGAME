# AulaGame — Worker de generación de preguntas con IA

Este Worker de Cloudflare es el intermediario seguro entre el sitio (`aulagames.teacherseba.com`)
y la API de Anthropic (Claude). Recibe el tema, la cantidad de preguntas y el UID del profesor,
**verifica en Firestore que el profesor tiene plan `premium`** (con una cuenta de servicio, no
confía en nada que envíe el navegador) y solo entonces llama a Claude Haiku y devuelve las
preguntas en el formato exacto que necesita cada juego.

La clave de la API de Anthropic **nunca** se expone en el navegador: vive solo como secreto de
Cloudflare, dentro de este Worker.

## 1. Requisitos

- Cuenta de Cloudflare (el plan gratis alcanza de sobra para este uso).
- Node.js instalado en tu computador (para usar `npx wrangler`).
- Tu clave de API de Anthropic (la que ya tienes de `console.anthropic.com`).
- Una **cuenta de servicio de Firebase** con acceso de lectura a Firestore del proyecto
  `aulagame-4c019` (instrucciones abajo, paso 3).

## 2. Instalar dependencias y autenticarte en Cloudflare

Abre una terminal (cmd/PowerShell) en la carpeta `cloudflare-worker` de este repositorio:

```
cd cloudflare-worker
npm install
npx wrangler login
```

Esto abrirá tu navegador para que inicies sesión en tu cuenta de Cloudflare y autorices a Wrangler
(la herramienta de línea de comandos de Cloudflare Workers).

## 3. Crear la cuenta de servicio de Firebase (para verificar el plan Premium)

El Worker necesita leer `profes/{uid}` en Firestore para confirmar `plan == "premium"`, pero lo
hace desde el servidor (no como el profesor logueado), así que necesita sus propias credenciales:

1. Ve a la [consola de Firebase](https://console.firebase.google.com/) → proyecto **aulagame-4c019**.
2. ⚙️ **Configuración del proyecto** → pestaña **Cuentas de servicio**.
3. Haz clic en **"Generar nueva clave privada"**. Se descargará un archivo `.json` — **no lo subas
   a este repositorio ni lo compartas**, es un secreto.
4. Guarda ese archivo en un lugar seguro de tu computador (fuera de la carpeta del proyecto). Lo
   necesitarás en el siguiente paso.

## 4. Configurar los secretos del Worker

Todavía dentro de `cloudflare-worker`, ejecuta uno por uno estos dos comandos. Wrangler te pedirá
que pegues el valor y presiones Enter — el valor **no** queda guardado en ningún archivo del
repositorio, solo en Cloudflare.

```
npx wrangler secret put ANTHROPIC_API_KEY
```
Pega tu clave de Anthropic (empieza con `sk-ant-...`) y presiona Enter.

```
npx wrangler secret put FIREBASE_SERVICE_ACCOUNT_JSON
```
Abre el archivo `.json` que descargaste en el paso 3 con el Bloc de notas, copia **todo** su
contenido (desde `{` hasta `}`) y pégalo completo cuando te lo pida. Presiona Enter.

## 5. Desplegar el Worker

```
npx wrangler deploy
```

Al terminar, Wrangler te mostrará una URL parecida a:

```
https://aulagame-ai-questions.TU-SUBDOMINIO.workers.dev
```

**Copia esa URL** — la necesitas para el último paso.

## 6. Conectar el sitio con el Worker

Abre `play/shared/ai-questions.js` en este repositorio y edita la primera línea de código
(constante `AI_WORKER_URL`), reemplazando el valor de ejemplo por la URL real que te dio
`wrangler deploy` en el paso anterior, agregando `/generate` al final:

```js
const AI_WORKER_URL = "https://aulagame-ai-questions.TU-SUBDOMINIO.workers.dev/generate";
```

Guarda el archivo y sube (`git push`) los cambios del sitio como de costumbre. Con eso, el botón
"✨ Generar con IA" de los 12 juegos ya apunta a tu Worker desplegado.

## 7. Probar que quedó bien conectado

Puedes probar el Worker directamente desde la terminal (reemplaza `TU-SUBDOMINIO` y `UID_DE_PRUEBA`
por un UID real de un profesor con `plan: "premium"` en Firestore, para confirmar que responde
`ok:true`; con un UID de plan gratis debería responder `403` con `code:"NOT_PREMIUM"`):

```
curl -X POST https://aulagame-ai-questions.TU-SUBDOMINIO.workers.dev/generate ^
  -H "Content-Type: application/json" ^
  -d "{\"uid\":\"UID_DE_PRUEBA\",\"game\":\"raceboard\",\"subject\":\"animales\",\"count\":5}"
```

## Actualizar el Worker más adelante

Si en el futuro modificas `cloudflare-worker/src/index.js` (por ejemplo, para agregar un juego
nuevo), solo necesitas repetir el paso 5 (`npx wrangler deploy`) — los secretos ya guardados
(`ANTHROPIC_API_KEY`, `FIREBASE_SERVICE_ACCOUNT_JSON`) se mantienen, no hace falta volver a
configurarlos.
