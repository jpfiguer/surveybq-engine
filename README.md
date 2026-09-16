# surveyBQ

> A dependency-free survey engine — responder, visual editor, analytics panel and
> BigQuery output. No build step, no npm install. Open the HTML and it runs.

Motor de encuestas (CSAT / NPS) escrito a mano, sin dependencias y sin build.
Son archivos estáticos: se abren con doble clic o se publican en cualquier
hosting. Nació como alternativa propia a SurveyJS y Qualtrics para un proyecto
de experiencia de clientes, donde el requisito era que el área de negocio
pudiera editar sus propias encuestas sin pasar por desarrollo.

Este repositorio es la **versión pública del motor**: no incluye las encuestas,
los datos ni la infraestructura de ningún cliente.

---

## Por qué sin dependencias

La decisión de fondo: quien escanea un QR llega con el navegador limpio, en un
teléfono cualquiera, a veces sin señal. Cada kilobyte y cada paso de build es
una forma de que eso falle. Sin `node_modules`, sin bundler y sin framework, el
respondedor es HTML y JavaScript que el navegador entiende directo.

El efecto secundario es que el repositorio sigue funcionando dentro de cinco
años sin que nadie tenga que resolver un árbol de dependencias roto.

---

## Las cinco pantallas

| Pantalla | Archivo | Para qué |
|----------|---------|----------|
| Portada | `index.html` | Listado, generador de enlaces para QR, exportación |
| Respondedor | `responder.html?survey=<id>` | Lo que ve quien responde |
| Editor | `editor.html?survey=<id>` | Editar preguntas, alternativas y lógica |
| Panel | `panel.html?survey=<id>` | Indicadores, gráficos y filtros |
| Imprimir | `imprimir.html?survey=<id>` | Formulario en papel y respuestas en PDF |

```bash
python3 -m http.server 8791
```

Y abre <http://localhost:8791>. También funciona abriendo `index.html` directo
desde el disco.

---

## Qué sabe hacer el motor

**15 tipos de pregunta** — `rating`, `radio`, `checkbox`, `dropdown`, `text`,
`comment`, `boolean`, `tagbox`, `matrix`, `ranking`, `multipletext`,
`imagepicker`, `file`, `signature` y `paneldynamic`.

**Lógica condicional** con un mini lenguaje de expresiones propio
(`src/core/expression.js`) para `visibleIf`, `enableIf` y `requiredIf`. La
sintaxis sigue en espíritu a la de SurveyJS para que a quien venga de ahí le
resulte familiar:

```js
{ id: 'motivo', type: 'comment', visibleIf: '{satisfaccion} <= 2' }
```

**Disparadores y campos calculados** que se evalúan al avanzar de página, no en
cada tecla.

**Localización** — cualquier etiqueta acepta `{ es: '...', en: '...' }`.

**Tolerancia a fallos del navegador.** `src/io/storage.js` asume que
`localStorage` puede no existir o estar bloqueado (modo incógnito, cookies
deshabilitadas) y sigue funcionando. Las respuestas se encolan y se reintentan
al recuperar la conexión.

---

## Arquitectura

```
src/core/     registry.js    registro de encuestas
              expression.js  mini lenguaje para la lógica condicional
              model.js       normalización del esquema de encuesta
              runtime.js     máquina de estado: valores, visibilidad,
                             navegación, validación, resultado final

src/io/       storage.js     persistencia en navegador + envío al endpoint
              bigquery.js    forma del registro que viaja a BigQuery
              analisis.js    agregación de respuestas

src/ui/       render.js      los 15 tipos de pregunta
              responder.js   respondedor
              editor.js      editor visual, en cinco pestañas
              panel.js       indicadores y gráficos
              hub.js         portada
              imprimir.js    salida a papel y PDF
              theme.js       tema claro/oscuro
```

La agregación (`src/io/analisis.js`) vive aparte de la interfaz a propósito:
los conteos se pueden probar sin navegador, que es justamente donde se cometen
los errores de análisis que nadie ve hasta que el informe ya salió.

---

## Salida a BigQuery

El respondedor envía cada respuesta a una función HTTP que escribe en BigQuery.
`endpoint/index.js` es esa función (Cloud Run / Cloud Functions, Node 18+), y
`bigquery/` trae el esquema y las vistas:

| Archivo | Qué crea |
|---------|----------|
| `01_esquema.sql` | Tabla de respuestas, particionada y agrupada |
| `02_vistas.sql` | Vistas de indicadores: CSAT por punto de servicio, causas, ranking |
| `04_definiciones.sql` | Catálogo de encuestas y versiones |

Cada cliente escribe en su propio dataset: las respuestas de uno no pueden
terminar en la infraestructura de otro, porque la factura, los permisos y un
eventual borrado van juntos. `tools/nuevo_cliente.sh` da de alta un cliente
nuevo de una sola vez — antes eran siete pasos sueltos y olvidar uno dejaba las
respuestas rechazadas.

Sin endpoint configurado (`config.js` con `endpoint: ''`), todo queda en el
navegador y se exporta a mano desde la portada. El motor funciona igual.

---

## Encuestas de ejemplo

- `surveys/demo-tipos.js` — recorre los 15 tipos de pregunta, en dos idiomas.
  Sirve de referencia al construir encuestas nuevas y de banco de pruebas al
  tocar el renderizador.
- `surveys/nps-relacional.js` — un NPS relacional completo.

`datos/muestra-demo.json` trae 250 respuestas simuladas para que el panel se vea
con datos al abrirlo por primera vez; el botón **Datos de ejemplo** las carga.
Están construidas con el motor de verdad, no escritas a mano, así que tienen la
misma forma que una respuesta real:

```bash
node tools/generar_muestra.js 250 > datos/muestra-demo.json
```

Las distribuciones son inventadas. No hay datos de ninguna encuesta real en
este repositorio.

---

## Licencia

MIT — ver [LICENSE](LICENSE).
