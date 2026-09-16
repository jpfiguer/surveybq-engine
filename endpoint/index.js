/*!
 * surveyBQ — función de ingesta.
 *
 * Recibe una respuesta ya en formato de fila BigQuery y la inserta.
 *
 * Es un endpoint PÚBLICO por necesidad: quien responde una encuesta anónima
 * en un mall no tiene cuenta de Google. Eso significa que cualquiera que
 * mire el código de la página puede escribir en la tabla. El riesgo no es
 * fuga de datos —no devuelve nada— sino basura entrando. Por eso:
 *
 *   · se valida la forma de la fila y se descarta lo que no calce
 *   · se limita el tamaño del cuerpo
 *   · se acotan las columnas a las del esquema, ignorando el resto
 *   · se registra el origen para poder distinguir el tráfico legítimo
 *
 * Si alguna vez la basura se vuelve un problema, el paso siguiente es poner
 * un reCAPTCHA o mover la escritura detrás de un API Gateway con cuota.
 */
'use strict';

const { BigQuery } = require('@google-cloud/bigquery');
const crypto = require('crypto');
const bq = new BigQuery();

const DATASET = process.env.SBQ_DATASET || 'experiencia_clientes';
const PROYECTO = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT || '';

/*
 * Un dataset por cliente, dentro del mismo proyecto.
 *
 * Se declara como "encuesta:dataset,encuesta:dataset". Cada cliente queda en
 * su propio dataset: BigQuery permite dar acceso a nivel de dataset, así que
 * se le puede abrir su información a un cliente sin mostrarle la de otro, y
 * borrar la de uno sin tocar la del resto. Compartir proyecto ahorra
 * facturación; compartir dataset sería mezclar clientes.
 *
 *   SBQ_DATASETS=encuesta-uno:cliente_uno,encuesta-dos:cliente_dos
 */
const MAPA_DATASETS = (process.env.SBQ_DATASETS || '')
  .split(',')
  .map(par => par.trim())
  .filter(Boolean)
  .reduce((acc, par) => {
    const i = par.indexOf(':');
    if (i > 0) acc[par.slice(0, i).trim()] = par.slice(i + 1).trim();
    return acc;
  }, {});

/*
 * El mapa encuesta -> cliente vive en config.clientes, no acá.
 *
 * Así dar de alta un cliente es insertar una fila, en vez de redesplegar las
 * tres funciones (seis a ocho minutos, y si una quedaba sin actualizar el
 * cliente funcionaba a medias).
 *
 * Se guarda en memoria por un rato: consultarlo en cada respuesta agregaría
 * ~400 ms a la apertura de cada QR. Con caché, solo la primera respuesta de
 * cada instancia lo paga. El costo es que un alta tarda hasta TTL en verse.
 */
const TABLA_CLIENTES = process.env.SBQ_TABLA_CLIENTES || 'config.clientes';
const TTL_MAPA = Number(process.env.SBQ_TTL_MAPA || 60) * 1000;
let mapaCache = null;
let mapaHasta = 0;

async function cargarMapa() {
  const ahora = Date.now();
  if (mapaCache && ahora < mapaHasta) return mapaCache;
  try {
    const [filas] = await bq.query({
      query: 'SELECT survey_id, dataset FROM `' + PROYECTO + '.' + TABLA_CLIENTES + '` ' +
             'WHERE activo IS NOT FALSE'
    });
    const m = {};
    filas.forEach(f => {
      // El dataset se concatena en SQL: solo nombres válidos entran.
      if (f.survey_id && f.dataset && /^[A-Za-z0-9_]{1,1024}$/.test(f.dataset)) {
        m[f.survey_id] = f.dataset;
      }
    });
    mapaCache = m;
    mapaHasta = ahora + TTL_MAPA;
    return m;
  } catch (err) {
    // Si la tabla no responde se usa el mapa de la variable de entorno: perder
    // respuestas por un problema de configuración sería peor que operar con un
    // mapa viejo. Si tampoco hay, se seguirá rechazando lo desconocido.
    console.warn('mapa: no se pudo leer config.clientes, usando el de respaldo',
                 (err && err.message) || err);
    mapaCache = MAPA_DATASETS;
    mapaHasta = ahora + 10000;   // reintentar pronto
    return mapaCache;
  }
}

/**
 * Dataset donde vive una encuesta, o null si no está declarada.
 *
 * Null a propósito en vez de un dataset por defecto: si se agrega una encuesta
 * y se olvida darla de alta, es preferible que sus respuestas se rechacen
 * —quedan en cola en el teléfono y se reintentan— a que terminen guardadas en
 * el dataset de otro cliente.
 */
async function datasetDe(surveyId) {
  if (!surveyId) return null;
  const mapa = await cargarMapa();
  const d = mapa[surveyId];
  return (d && /^[A-Za-z0-9_]{1,1024}$/.test(d)) ? d : null;
}
const TABLA   = process.env.SBQ_TABLE   || 'survey_responses';
const ORIGENES = (process.env.SBQ_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const MAX_BYTES = 256 * 1024;   // una respuesta ronda los 2 KB; 256 KB es holgado

/** Columnas del esquema. Lo que no esté acá se descarta en silencio. */
const COLUMNAS = new Set([
  'response_id', 'survey_id', 'survey_version', 'survey_title', 'status',
  'centro_comercial', 'touchpoint', 'sector_contexto',
  'score_type', 'score', 'score_bucket', 'csat_satisfecho',
  'palanca', 'palanca_otro', 'causa_raiz', 'causa_raiz_otro', 'comentario_abierto',
  'genero', 'rango_etario',
  'fecha_inicio', 'fecha_termino', 'fecha', 'mes', 'dia_semana', 'horario',
  'duracion_seg', 'progreso', 'finalizado',
  'adjuntos', 'idioma_respuesta', 'puntaje', 'puntaje_maximo',
  'answers', 'canal', 'user_agent', 'idioma', 'ingested_at'
]);

function cors(req, res) {
  const origen = req.headers.origin;
  // Sin lista configurada se acepta cualquier origen: en un mall la encuesta
  // puede terminar embebida en más de un sitio.
  const permitido = !ORIGENES.length || ORIGENES.includes(origen);
  res.set('Access-Control-Allow-Origin', permitido && origen ? origen : '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, X-SBQ-Origen, X-SBQ-Clave');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Max-Age', '3600');
  return permitido;
}

/** Comprueba que la fila tenga la forma esperada antes de tocar BigQuery. */
function validar(fila) {
  if (!fila || typeof fila !== 'object' || Array.isArray(fila)) return 'cuerpo no es un objeto';
  if (!fila.response_id || typeof fila.response_id !== 'string') return 'falta response_id';
  if (fila.response_id.length > 64) return 'response_id demasiado largo';
  if (!fila.survey_id || typeof fila.survey_id !== 'string') return 'falta survey_id';
  if (!fila.fecha_inicio) return 'falta fecha_inicio';
  if (fila.score !== null && fila.score !== undefined && typeof fila.score !== 'number') {
    return 'score no es numérico';
  }
  if (fila.answers && !Array.isArray(fila.answers)) return 'answers no es una lista';
  if (fila.answers && fila.answers.length > 500) return 'demasiadas respuestas';
  return null;
}

/** Deja solo las columnas del esquema. */
function limpiar(fila) {
  const out = {};
  for (const k of Object.keys(fila)) if (COLUMNAS.has(k)) out[k] = fila[k];

  // El servidor pone la marca de tiempo: la del cliente puede venir con el
  // reloj corrido y arruinaría cualquier partición por fecha.
  out.ingested_at = new Date().toISOString();
  return out;
}

exports.ingest = async (req, res) => {
  const permitido = cors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'usa POST' });
  if (!permitido) return res.status(403).json({ ok: false, error: 'origen no permitido' });

  const largo = Number(req.headers['content-length'] || 0);
  if (largo > MAX_BYTES) {
    return res.status(413).json({ ok: false, error: 'cuerpo demasiado grande' });
  }

  // Una lista permite enviar la cola acumulada de una vez cuando vuelve la
  // conexión, en lugar de una petición por respuesta.
  const cuerpo = req.body;
  const filas = Array.isArray(cuerpo) ? cuerpo : [cuerpo];
  if (filas.length > 50) {
    return res.status(413).json({ ok: false, error: 'máximo 50 respuestas por envío' });
  }

  const validas = [];
  const rechazadas = [];
  for (const f of filas) {
    const error = validar(f);
    if (error) rechazadas.push({ response_id: f && f.response_id, error });
    else validas.push(limpiar(f));
  }

  if (!validas.length) {
    console.warn('ingesta rechazada', JSON.stringify(rechazadas));
    return res.status(400).json({ ok: false, rechazadas });
  }

  // Las respuestas de un envío pueden ser de encuestas distintas; cada una va
  // al dataset de su cliente.
  // El mapa se resuelve una vez para todo el envío, no por fila.
  const mapa = await cargarMapa();
  const porDataset = {};
  validas.forEach(f => {
    const d = mapa[f.survey_id];
    if (!d) {
      rechazadas.push({ response_id: f.response_id,
                        error: 'encuesta sin dataset configurado: ' + f.survey_id });
      return;
    }
    (porDataset[d] = porDataset[d] || []).push(f);
  });

  if (!Object.keys(porDataset).length) {
    console.warn('ingesta sin destino', JSON.stringify(rechazadas));
    return res.status(400).json({ ok: false, rechazadas });
  }

  try {
    for (const d of Object.keys(porDataset)) {
      await bq.dataset(d).table(TABLA).insert(porDataset[d], {
        ignoreUnknownValues: true,
        raw: false
      });
    }
    console.log('ingesta ok', JSON.stringify({
      n: validas.length,
      datasets: Object.keys(porDataset),
      origen: req.headers['x-sbq-origen'] || 'sin-origen',
      rechazadas: rechazadas.length
    }));
    return res.status(200).json({ ok: true, insertadas: validas.length, rechazadas });
  } catch (err) {
    const detalle = err.errors ? JSON.stringify(err.errors).slice(0, 900) : err.message;
    console.error('fallo al insertar', detalle);
    return res.status(500).json({ ok: false, error: 'no se pudo insertar' });
  }

};

const MAX_FILAS = Number(process.env.SBQ_PANEL_MAX || 20000);

/**
 * Clave del panel, comparada en tiempo constante para no filtrarla por el
 * reloj. Es distinta de la del editor: ver resultados y cambiar lo que se
 * pregunta no son el mismo permiso.
 */
function claveValida(recibida) {
  const esperada = process.env.SBQ_PANEL_CLAVE || '';
  if (!esperada || !recibida) return false;
  const a = Buffer.from(String(recibida));
  const b = Buffer.from(esperada);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Aplana los envoltorios de tipo de BigQuery ({value:'...'}) a su valor. */
function aplanar(v) {
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.map(aplanar);
  if (typeof v === 'object') {
    var claves = Object.keys(v);
    if (claves.length === 1 && claves[0] === 'value') return v.value;
    var o = {};
    for (const k of claves) o[k] = aplanar(v[k]);
    return o;
  }
  return v;
}

exports.panelRead = async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'usa GET o POST' });
  }

  const clave = req.get('X-SBQ-Clave') || (req.body && req.body.clave) ||
                (req.query && req.query.clave) || '';
  if (!claveValida(clave)) {
    console.warn('panel: clave incorrecta desde', req.headers.origin || '?');
    return res.status(401).json({ ok: false, error: 'clave incorrecta' });
  }

  // La encuesta es obligatoria: cada cliente vive en su propio dataset y una
  // consulta sin encuesta tendría que barrer todos, que es justo lo que la
  // separación evita.
  const survey = (req.query && req.query.survey) || (req.body && req.body.survey) || null;
  if (!survey) return res.status(400).json({ ok: false, error: 'falta la encuesta' });
  const ds = await datasetDe(survey);
  if (!ds) return res.status(404).json({ ok: false, error: 'encuesta desconocida' });

  try {
    const [rows] = await bq.query({
      query: 'SELECT * FROM `' + PROYECTO + '.' + ds + '.' + TABLA + '` ' +
             'WHERE survey_id = @survey ORDER BY fecha_inicio LIMIT ' + MAX_FILAS,
      params: { survey: survey }
    });
    const datos = rows.map(aplanar);
    console.log('panel: ' + datos.length + ' filas entregadas' + (survey ? ' (' + survey + ')' : ''));
    res.status(200).json({ ok: true, respuestas: datos });
  } catch (err) {
    console.error('panel: fallo en la consulta', (err && err.message) || err);
    res.status(500).json({ ok: false, error: 'no se pudo consultar' });
  }
};

/**
 * surveyBQ — encuestas publicadas desde el editor.
 *
 *   GET  ?id=demo-tipos          -> la última versión publicada (público)
 *   POST {survey:{...}, notas}    -> publica una versión nueva (pide clave)
 *   POST {accion:'validar'}       -> solo comprueba la clave, no publica
 *
 * La lectura es pública a propósito: el respondedor la consulta al abrirse y
 * quien escanea un QR no tiene cuenta. Lo que va protegido es escribir, que es
 * lo que cambia la encuesta que está en la calle. Por eso la clave del editor
 * es distinta de la del panel: ver resultados y modificar lo que se pregunta
 * no son el mismo permiso.
 *
 * Cada publicación agrega una fila; nunca se sobrescribe. El historial es lo
 * que permite entender respuestas viejas cuando la encuesta ya cambió.
 */
const TABLA_DEF = process.env.SBQ_TABLE_DEF || 'survey_definitions';
const MAX_DEF = 512 * 1024;   // una encuesta grande ronda los 90 KB

function claveEditorValida(recibida) {
  const esperada = process.env.SBQ_EDITOR_CLAVE || '';
  if (!esperada || !recibida) return false;
  const a = Buffer.from(String(recibida));
  const b = Buffer.from(esperada);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

exports.encuestas = async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).send('');

  // ---------------------------------------------------------------- lectura
  if (req.method === 'GET') {
    const id = req.query && req.query.id;
    if (!id) return res.status(400).json({ ok: false, error: 'falta id' });
    const dsDef = await datasetDe(id);
    if (!dsDef) return res.status(404).json({ ok: false, error: 'encuesta desconocida' });
    try {
      const [filas] = await bq.query({
        query: 'SELECT definicion, version, publicado_en FROM `' +
               PROYECTO + '.' + dsDef + '.' + TABLA_DEF + '` ' +
               'WHERE survey_id = @id ORDER BY publicado_en DESC LIMIT 1',
        params: { id: id }
      });
      if (!filas.length) return res.status(404).json({ ok: false, error: 'sin versión publicada' });
      const f = filas[0];
      // Se devuelve ya parseada para que el cliente no tenga que hacerlo.
      return res.status(200).json({
        ok: true,
        version: f.version,
        publicado_en: f.publicado_en && f.publicado_en.value ? f.publicado_en.value : f.publicado_en,
        survey: JSON.parse(f.definicion)
      });
    } catch (err) {
      console.error('encuestas: fallo al leer', (err && err.message) || err);
      return res.status(500).json({ ok: false, error: 'no se pudo leer' });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'usa GET o POST' });

  // -------------------------------------------------------------- escritura
  const clave = req.get('X-SBQ-Clave') || (req.body && req.body.clave) || '';
  if (!claveEditorValida(clave)) {
    console.warn('editor: clave incorrecta desde', req.headers.origin || '?');
    return res.status(401).json({ ok: false, error: 'clave incorrecta' });
  }

  const cuerpo = req.body || {};
  if (cuerpo.accion === 'validar') return res.status(200).json({ ok: true });

  const survey = cuerpo.survey;
  if (!survey || typeof survey !== 'object' || !survey.id) {
    return res.status(400).json({ ok: false, error: 'falta la encuesta o su id' });
  }
  if (!Array.isArray(survey.pages) || !survey.pages.length) {
    return res.status(400).json({ ok: false, error: 'la encuesta no tiene páginas' });
  }
  const json = JSON.stringify(survey);
  if (json.length > MAX_DEF) {
    return res.status(413).json({ ok: false, error: 'la encuesta es demasiado grande' });
  }

  const dsPub = await datasetDe(survey.id);
  if (!dsPub) {
    return res.status(400).json({ ok: false, error: 'encuesta sin dataset configurado' });
  }

  try {
    await bq.dataset(dsPub).table(TABLA_DEF).insert([{
      survey_id: survey.id,
      version: survey.version || null,
      titulo: typeof survey.title === 'string' ? survey.title
              : (survey.title && survey.title.es) || null,
      definicion: json,
      publicado_en: new Date().toISOString(),
      publicado_por: String(cuerpo.autor || '').slice(0, 120) || null,
      notas: String(cuerpo.notas || '').slice(0, 500) || null
    }]);
    console.log('editor: publicada ' + survey.id + ' (' + json.length + ' bytes)');
    res.status(200).json({ ok: true, survey_id: survey.id, bytes: json.length });
  } catch (err) {
    const detalle = err.errors ? JSON.stringify(err.errors).slice(0, 700) : err.message;
    console.error('editor: fallo al publicar', detalle);
    res.status(500).json({ ok: false, error: 'no se pudo publicar' });
  }
};
