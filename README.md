# surveyBQ

> A dependency-free survey engine — responder, visual editor, analytics panel and
> BigQuery output. No build step, no npm install. Open the HTML and it runs.

A CSAT/NPS survey engine written by hand, with no dependencies and no build. It's
static files: open them by double-clicking or publish them on any host. It started
as an in-house alternative to SurveyJS and Qualtrics for a customer-experience
project where the requirement was that the business team could edit their own
surveys without going through engineering.

This repository is the **public version of the engine**: it contains no client's
surveys, data or infrastructure.

---

## Why no dependencies

The underlying decision: whoever scans a QR code arrives on a clean browser, on
some phone, sometimes with no signal. Every kilobyte and every build step is a
way for that to fail. With no `node_modules`, no bundler and no framework, the
responder is HTML and JavaScript the browser understands directly.

The side effect is that the repository still works five years from now without
anyone having to untangle a broken dependency tree.

---

## The five screens

| Screen | File | What it's for |
|--------|------|---------------|
| Home | `index.html` | Listing, QR link generator, export |
| Responder | `responder.html?survey=<id>` | What the respondent sees |
| Editor | `editor.html?survey=<id>` | Edit questions, options and logic |
| Panel | `panel.html?survey=<id>` | Metrics, charts and filters |
| Print | `imprimir.html?survey=<id>` | Paper form and answers as PDF |

```bash
python3 -m http.server 8791
```

Then open <http://localhost:8791>. It also works opening `index.html` straight
from disk.

---

## What the engine can do

**15 question types** — `rating`, `radio`, `checkbox`, `dropdown`, `text`,
`comment`, `boolean`, `tagbox`, `matrix`, `ranking`, `multipletext`,
`imagepicker`, `file`, `signature` and `paneldynamic`.

**Conditional logic** through a small in-house expression language
(`src/core/expression.js`) for `visibleIf`, `enableIf` and `requiredIf`. The
syntax follows SurveyJS in spirit so that anyone coming from there finds it
familiar:

```js
{ id: 'reason', type: 'comment', visibleIf: '{satisfaction} <= 2' }
```

**Triggers and computed fields** evaluated on page advance, not on every
keystroke.

**Localization** — any label accepts `{ es: '...', en: '...' }`.

**Tolerance for browser failures.** `src/io/storage.js` assumes `localStorage`
may not exist or may be blocked (private mode, cookies disabled) and keeps
working. Answers are queued and retried when the connection comes back.

---

## Architecture

```
src/core/     registry.js    survey registry
              expression.js  small language for conditional logic
              model.js       survey schema normalization
              runtime.js     state machine: values, visibility,
                             navigation, validation, final result

src/io/       storage.js     browser persistence + sending to the endpoint
              bigquery.js    shape of the record that travels to BigQuery
              analisis.js    answer aggregation

src/ui/       render.js      the 15 question types
              responder.js   responder
              editor.js      visual editor, in five tabs
              panel.js       metrics and charts
              hub.js         home
              imprimir.js    paper and PDF output
              theme.js       light/dark theme
```

Aggregation (`src/io/analisis.js`) lives apart from the interface on purpose: the
counts can be tested without a browser, which is exactly where the analysis bugs
nobody notices until the report is already out get made.

---

## BigQuery output

The responder sends each answer to an HTTP function that writes to BigQuery.
`endpoint/index.js` is that function (Cloud Run / Cloud Functions, Node 18+), and
`bigquery/` holds the schema and views:

| File | What it creates |
|------|-----------------|
| `01_esquema.sql` | Answers table, partitioned and clustered |
| `02_vistas.sql` | Metric views: CSAT by touchpoint, causes, ranking |
| `04_definiciones.sql` | Survey and version catalog |

Each client writes to its own dataset: one client's answers can't end up in
another's infrastructure, because the bill, the permissions and any eventual
deletion travel together. `tools/nuevo_cliente.sh` onboards a new client in one
go — it used to be seven separate steps, and forgetting one left answers being
rejected.

With no endpoint configured (`config.js` with `endpoint: ''`), everything stays
in the browser and is exported by hand from the home screen. The engine works
the same.

---

## Example surveys

- `surveys/demo-tipos.js` — walks through all 15 question types, in two
  languages. It doubles as a reference when building new surveys and as a test
  bed when touching the renderer.
- `surveys/nps-relacional.js` — a complete relational NPS.

`datos/muestra-demo.json` ships 250 simulated answers so the panel shows data the
first time you open it; the **Datos de ejemplo** button loads them. They're built
with the real engine rather than written by hand, so they have the same shape as
a real answer:

```bash
node tools/generar_muestra.js 250 > datos/muestra-demo.json
```

The distributions are invented. There is no data from any real survey in this
repository.

---

## License

MIT — see [LICENSE](LICENSE).
