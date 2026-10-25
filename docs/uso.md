# Revisión de tesis — guía de uso

Tus directores comentan el PDF de la tesis en una página web privada; tú recibes
los comentarios en la web, por Telegram, por correo y en Emacs, junto al código
org de cada capítulo.

- [Para ti (autor)](#para-ti-autor)
  - [Configuración inicial](#configuración-inicial)
  - [Publicar una versión](#publicar-una-versión)
  - [avance.json](#avancejson)
  - [Enlaces de los directores](#enlaces-de-los-directores)
  - [Leer y responder comentarios](#leer-y-responder-comentarios)
  - [Emacs (Doom)](#emacs-doom)
  - [Avisos: Telegram y correo](#avisos-telegram-y-correo)
- [Para los directores](#para-los-directores) (texto para enviarles)

![Vista del director](images/03-visor-director.png)

## Para ti (autor)

### Configuración inicial

1. Genera tu token de autor:

   ```sh
   revision-tesis gen-token
   ```

   La primera línea es el **token** (tuyo, secreto); la segunda es su **SHA-256**,
   que es lo único que conoce el servidor (`OWNER_TOKEN_SHA256` en el Secret del
   clúster, ver `docs/deploy.md`).

2. Guarda la dirección del sitio y el token en `~/.config/revision-tesis/config.json`,
   legible solo por ti:

   ```sh
   mkdir -p ~/.config/revision-tesis
   cat > ~/.config/revision-tesis/config.json <<'EOF'
   {"url": "https://tesis.hao.systems", "token": "rt_owner_…"}
   EOF
   chmod 600 ~/.config/revision-tesis/config.json
   ```

   La CLI y Emacs se niegan a usar el archivo si otros usuarios pueden leerlo, y
   si la dirección no empieza con `https://` (el token viaja en cada petición;
   `http://` solo se acepta para `localhost` o `127.0.0.1`).

3. En el navegador, entra una vez en `https://tesis.hao.systems/entrar` con el
   token: queda una sesión de 30 días en ese navegador (se renueva sola mientras
   la uses).

   - **Cambiar el token** (`gen-token` otra vez y el SHA-256 nuevo en el Secret)
     cierra todas tus sesiones del navegador abiertas con el anterior.
   - **Cerrar todas las sesiones**: en el panel, Ajustes → Sesiones, o
     `revision-tesis sessions close-all`. Cierra tus sesiones del navegador en
     todos los equipos (la CLI y Emacs siguen funcionando con el token); con la
     casilla «También las de todos los directores» (`--directors`), los
     directores tienen que abrir de nuevo su enlace personal. Úsalo si perdiste
     un equipo o sospechas que alguien usó tu sesión.

![Panel del autor](images/04-panel-autor.png)

### Publicar una versión

Compila la tesis como siempre (`make pdf` en la carpeta de la tesis) y genera
`avance.json`; luego publica `tesis.pdf` + `avance.json` con una nota opcional.
Cada publicación es una **versión nueva**; los comentarios se quedan en la versión
sobre la que se hicieron.

- **Emacs**: desde cualquier archivo de la tesis, `M-x revision-tesis-publicar`
  (`SPC m z p`). Busca `tesis.org` hacia arriba, sube `tesis.pdf` y `avance.json`
  de esa carpeta y te pide la nota. Te avisa si el PDF es más viejo que los `.org`.
- **CLI** (o desde el Makefile):

  ```sh
  revision-tesis avance tesis.org -o avance.json
  revision-tesis publish tesis.pdf avance.json -m "Atendí los comentarios del capítulo 2"
  ```

  Un objetivo de Makefile posible:

  ```make
  publicar: tesis.pdf
  	revision-tesis avance tesis.org -o avance.json
  	revision-tesis publish tesis.pdf avance.json -m "$(NOTA)"
  ```

- **Web**: en tu panel, «Publicar una versión desde el navegador».

El servidor revisa que el archivo sea un PDF válido (máximo 50 MB) y que
`avance.json` cumpla el formato. Si algún director pidió avisos por correo, recibe
un aviso de la versión nueva con la nota (sin su enlace personal).

### avance.json

```json
{"schema": 1, "title": "…", "generated_at": "2026-10-24T18:00:00Z", "total_words": 2950,
 "chapters": [{"id": "01-introduccion", "title": "Introducción", "words": 1450,
               "goal": 3000, "status": "revision"}]}
```

`status` es `borrador`, `revision`, `terminado` o `null`; `goal` es una meta de
palabras o `null`. `revision-tesis avance tesis.org` lo genera: un capítulo por
cada `#+INCLUDE:` de `tesis.org` (el `id` es el nombre del archivo, el título es
su primer encabezado), contando las palabras sin marcado, comentarios, bloques de
comentario ni citas. La meta y el estado salen de dos líneas opcionales en cada
capítulo:

```org
#+AVANCE_META: 6000
#+AVANCE_ESTADO: borrador
```

Para que Emacs lo regenere antes de publicar:

```elisp
(setq revision-tesis-avance-command "revision-tesis avance tesis.org -o avance.json")
```

En la web, cada versión muestra **Avance y cambios**: la tabla por capítulo
(palabras, cambio respecto a la versión anterior, meta, estado) y qué cambió en el
texto, oración por oración, por capítulo. El servidor ubica cada capítulo en el
PDF por su título; si no lo encuentra, compara el documento completo.

![Avance y cambios](images/06-cambios.png)

### Enlaces de los directores

Cada director entra con un **enlace personal** que lo identifica por su nombre.
El enlace se muestra **una sola vez** al crearlo; el servidor solo guarda una
huella (hash).

- **Crear**: en el panel, «Agregar director» (nombre, rol, correo opcional), o

  ```sh
  revision-tesis directors add "Dra. Ana Torres Ruiz" --role Director --email ana@… --replies instant
  revision-tesis directors add "Dr. Luis Méndez Ortega" --role Codirector
  ```

  - «Avisarle por correo cuando publique una versión nueva» (`--notify`): opcional,
    requiere correo.
  - «Enviar enlace por correo» (`--send-link`): el enlace va **solo** en ese
    correo y solo si marcas la opción. Si no, cópialo y envíalo tú por un canal
    privado.
- **Enlace nuevo** (rotar): genera otro enlace; el anterior y las sesiones abiertas
  con él dejan de funcionar. Úsalo si un enlace se perdió o se compartió de más.
  `revision-tesis directors rotate ID [--send-link]`.
- **Revocar**: corta el acceso de inmediato (enlace y sesiones).
  `revision-tesis directors revoke ID`. «Reactivar con enlace nuevo» lo vuelve a
  habilitar con un enlace distinto.
- `revision-tesis directors list` muestra los IDs.

Al abrir el enlace, el navegador del director guarda una sesión (180 días, que se
renuevan mientras la use) y la dirección cambia a la página principal, para que
el enlace secreto no quede en el historial. Si ese navegador ya tenía abierta la
sesión de otra persona (la tuya, por ejemplo, si pruebas el enlace en tu
navegador), primero pregunta «¿Entrar como …?» en lugar de cambiar de usuario
sin avisar.

**Qué comentarios ve cada director** (Ajustes): «Todos» (por omisión; colaboran
entre ellos) o «Solo los suyos y los tuyos». Con «Solo los suyos y los tuyos»,
cada director ve sus hilos y los tuyos, y dentro de ellos solo tus mensajes y los
suyos: las respuestas de otro director en un hilo tuyo no se le muestran (ni
quién lo resolvió, si fue otro director), y tampoco le llegan por correo.

**Avisos de respuestas a los directores** (columna «Correo» del panel, lista
«Respuestas»; o `revision-tesis directors replies ID instant|daily|never`):
cuando alguien más responde en un hilo que el director abrió o en el que
respondió, puede recibir un correo **al momento**, un **resumen diario** o
**nunca** (por omisión). El director también puede cambiarlo él mismo en
«Notificaciones», arriba en su vista. Los correos llevan un enlace al hilo, nunca
su enlace personal (si el sitio le pide entrar, debe usar su enlace personal), y
respetan la visibilidad: nunca avisan de un comentario que el director no puede
ver. Requiere correo configurado en el servidor y un correo registrado para el
director.

Cada director puede escribir hasta 500 comentarios y respuestas en 24 horas
(`MAX_DIRECTOR_COMMENTS_PER_DAY`), además del límite de 60 por minuto.

### Leer y responder comentarios

- **Web**: en cada versión, la columna derecha lista los hilos; «Mostrar
  resueltos» muestra también los cerrados. Puedes responder, marcar resuelto o
  reabrir, y editar o eliminar tus propios mensajes.
- **Quién resuelve**: un hilo solo lo pueden marcar como resuelto quien lo abrió
  y tú (siempre, también desde Emacs y la CLI). Cualquiera que vea el hilo puede
  reabrirlo. A los demás directores no se les muestra «Marcar resuelto».
- **Telegram / correo**: un aviso por cada comentario o respuesta de un director,
  con la cita y el enlace al hilo; o un resumen diario. Si un director **edita**
  un comentario, también te llega un aviso con el texto anterior y el nuevo (el
  servidor guarda las últimas 20 versiones: `GET /api/comments/ID/edits`).
- **CLI**: `revision-tesis comments` (abiertos), `--all`, `--version N`, `--json`.
- **Emacs**: `M-x revision-tesis-comentarios` (`SPC m z c`) abre un buffer org con
  los hilos abiertos agrupados por capítulo y página: autor, fecha, cita,
  comentarios, un enlace al lugar del `.org` donde está el texto citado, y un
  enlace al hilo en la web. Los que no se pudieron ubicar (comentarios sobre un
  punto, o texto que ya cambió) van al final, con un enlace al archivo del
  capítulo. Con el cursor en un hilo: `SPC m z r` responde, `SPC m z x` lo
  resuelve (`C-u` para reabrir; como autor puedes resolver cualquier hilo),
  `SPC m z c` actualiza. El texto de los directores se muestra sin caracteres de
  control ni de dirección (bidi), igual que en la CLI.

![Respuesta del autor](images/05-visor-autor.png)

### Emacs (Doom)

`emacs/revision-tesis.el` es Emacs Lisp puro (url.el, JSON nativo; Emacs 29 o
más nuevo). En `~/.config/doom/config.el`:

```elisp
;; Revisión de la tesis: comentarios de los directores sobre el PDF.
(use-package! revision-tesis
  :load-path "~/dev/lalohao/revision-tesis/emacs"
  :commands (revision-tesis-publicar revision-tesis-comentarios
             revision-tesis-responder revision-tesis-resolver
             revision-tesis-actualizar revision-tesis-mode)
  ;; Notas de Flymake en los .org de una tesis (si existe config.json).
  :hook (org-mode . revision-tesis-maybe-enable))

;; Bajo el localleader de org, en "z": Org no usa esa tecla y "w" ya es de research.
(map! :after org
      :map org-mode-map
      :localleader
      (:prefix ("z" . "revisión (directores)")
       :desc "Publicar versión"       "p" #'revision-tesis-publicar
       :desc "Comentarios"            "c" #'revision-tesis-comentarios
       :desc "Responder hilo"         "r" #'revision-tesis-responder
       :desc "Resolver hilo"          "x" #'revision-tesis-resolver
       :desc "Actualizar notas"       "a" #'revision-tesis-actualizar
       :desc "Notas en el texto"      "m" #'revision-tesis-mode))
```

No hace falta `doom sync` (no es un paquete descargado): basta recargar la
configuración.

- **Notas en el texto** (`revision-tesis-mode`): cada comentario abierto aparece
  como nota de Flymake sobre el texto citado en el `.org`. Los comentarios se
  descargan en segundo plano al abrir el archivo; `SPC m z a` los vuelve a pedir.
  Si la descarga falla (token incorrecto, servidor caído), el motivo aparece en el
  área de eco en lugar de quedarse sin notas en silencio.
  Con el cursor sobre una nota, `SPC m z r` responde a ese hilo. Doom usa Flycheck
  para otros chequeos; Flymake funciona a la par.
- **Cómo se ubica la cita**: se comparan solo letras y números (sin espacios,
  guiones de partición, ligaduras ni puntuación), después de quitar del `.org` los
  cajones `:PROPERTIES:`, comentarios, `#+…`, citas `[cite:…]`, destinos de
  enlaces y comandos LaTeX (`\gls{LLM}` cuenta como «LLM»). Si no hay coincidencia
  exacta (editaste el párrafo después de compilar, o el PDF expandió una sigla), se
  busca el lugar donde coinciden más pedazos de la cita. Citas de menos de 8
  letras no se ubican.

### Avisos: Telegram y correo

Cada canal se activa por separado (ver la tabla de variables en el README).

- **Telegram**: crea un bot con @BotFather (te da `TELEGRAM_BOT_TOKEN`), escríbele
  algo y obtén tu `TELEGRAM_CHAT_ID` con
  `curl https://api.telegram.org/bot<TOKEN>/getUpdates`. Los mensajes son texto
  plano con el enlace al hilo; nunca llevan secretos.
- **Correo (Proton Mail)**: el envío por SMTP de Proton requiere un plan de pago y
  una **dirección con dominio propio**. En Proton: Configuración → Todas las
  configuraciones → IMAP/SMTP → Tokens SMTP → Generar token; elige la dirección y
  copia el token (solo se muestra una vez). Servidor `smtp.protonmail.ch`, puerto
  587, STARTTLS; usuario: esa dirección; contraseña: el token (tu contraseña de
  Proton no sirve). Proton Bridge no es adecuado para el clúster.
  - `EMAIL_OWNER_TO`: tu dirección para los avisos de comentarios.
  - Correo a directores: solo a quienes tengan correo y avisos activados, al
    publicar una versión, y el enlace personal solo con «Enviar enlace por correo».
- **Resumen diario**: `DIGEST_HOUR=8` envía a las 8:00 (hora de `TZ`) los
  comentarios de directores de las últimas 24 horas, por los canales activos.
  Con `NOTIFY_INSTANT=false` solo llega el resumen. Si todos los canales fallan,
  se vuelve a intentar cada 5 minutos ese mismo día. Los resúmenes diarios de los
  directores que lo eligieron salen a la misma hora (a las 8:00 si `DIGEST_HOUR`
  no está definido).

## Para los directores

*(Texto para enviar junto con el enlace.)*

> Estimado(a) doctor(a):
>
> Para revisar la tesis, abra su **enlace personal** (no lo comparta: sus
> comentarios aparecen con su nombre). El navegador recordará su acceso; después
> puede volver a la dirección del sitio sin el enlace.
>
> - **Comentar un texto**: seleccione con el ratón el texto del PDF y pulse
>   «Comentar selección». Escriba su comentario y pulse «Publicar comentario».
> - **Comentar un lugar** (una figura, un espacio): pulse «Comentar un punto» y
>   haga clic en el lugar de la página.
> - Sus comentarios y los de los demás aparecen a la derecha. Puede **responder**
>   y **reabrir** cualquier hilo, **marcar resuelto** los hilos que usted abrió, y
>   **editar** o **eliminar** sus propios comentarios. El texto admite
>   `**negritas**`, `*cursivas*` y enlaces.
> - Arriba puede cambiar de **versión**. «Avance y cambios» muestra el avance por
>   capítulo y qué cambió respecto a la versión anterior.
> - En **Notificaciones** (arriba) puede elegir si quiere un correo cuando
>   alguien responda en sus hilos (al momento, un resumen diario o nunca) y cuando
>   se publique una versión nueva. Los correos traen un enlace al hilo; si el
>   sitio le pide entrar, use su enlace personal.
>
> Gracias por su revisión.

![Comentar una selección](images/02-comentario.png)
