/*!
 * surveyBQ — imprimir.js
 * Vistas para papel y para PDF.
 *
 *   formulario   la encuesta en blanco, para llenar a mano
 *   respuestas   una respuesta por hoja, para adjuntar a un caso
 *
 * No se genera un .pdf con una librería a propósito: el navegador exporta
 * estas páginas a PDF con texto real y seleccionable, respetando la
 * tipografía. Rasterizar la página produciría un PDF pesado, sin texto
 * buscable y con la letra borrosa al hacer zoom.
 *
 * El formulario en papel no tiene lógica que se ejecute, así que las
 * condiciones se imprimen como instrucciones: «Responde solo si en la 5
 * marcaste Limpieza».
 */
(function (global) {
  'use strict';

  var SBQ = global.SBQ;
  var doc = global.document;
  var Model = SBQ.Model;
  /* Ayudante propio: esta página no carga el renderizador, porque no dibuja
     controles interactivos. Menos scripts, impresión más rápida. */
  function el(t, c, h) {
    var n = doc.createElement(t);
    if (c) n.className = c;
    if (h != null) n.innerHTML = h;
    return n;
  }
  var esc = SBQ.util.esc;

  var survey = null;
  var modo = 'formulario';
  var opciones = { instrucciones: true, todasLasRamas: true, vacias: false };
  var refs = {};

  function boot() {
    refs.hoja = doc.getElementById('sbq-hoja');
    refs.picker = doc.getElementById('sbq-picker');
    refs.modo = doc.getElementById('sbq-modo');
    refs.opciones = doc.getElementById('sbq-opciones');
    refs.aviso = doc.getElementById('sbq-aviso');

    Object.keys(SBQ.surveys).forEach(function (id) {
      var o = doc.createElement('option');
      o.value = id;
      o.textContent = SBQ.surveys[id].title;
      refs.picker.appendChild(o);
    });

    var p = SBQ.util.queryParams();
    refs.picker.value = Object.keys(SBQ.surveys).indexOf(p.survey) >= 0
      ? p.survey : Object.keys(SBQ.surveys)[0];
    if (p.modo === 'respuestas') refs.modo.value = 'respuestas';
    modo = refs.modo.value;

    refs.picker.onchange = function () { cargar(); };
    refs.modo.onchange = function () { modo = refs.modo.value; cargar(); };
    doc.getElementById('btn-imprimir').onclick = function () { global.print(); };

    cargar();
  }

  function cargar() {
    survey = Model.normalize(SBQ.getSurvey(refs.picker.value));
    SBQ.theme.apply(survey.theme);
    dibujarOpciones();
    dibujar();
  }

  /**
   * Texto para papel.
   *
   * Las variables de la encuesta SÍ se conocen al imprimir (el nombre del
   * centro comercial, por ejemplo) y se reemplazan. Las referencias a
   * respuestas de la propia persona no, porque el formulario está en blanco:
   * quedan como puntos suspensivos en vez de mostrar la llave cruda.
   */
  function txt(v) {
    var t = Model.localized(v, survey.locale, survey.locale);
    if (typeof t !== 'string') return t == null ? '' : String(t);
    // Primero las referencias que NO son variables: pipe las borraría dejando
    // "con nota ?" en vez de "con nota …".
    var vars = survey.variables || {};
    t = t.replace(/\{([A-Za-z0-9_]+)(\.[A-Za-z0-9_]+)?\}/g, function (m, nombre) {
      return vars[nombre] !== undefined ? m : '…';
    });
    t = Model.pipe(t, vars, survey);
    return t.replace(/\s{2,}/g, ' ');
  }

  function dibujarOpciones() {
    refs.opciones.innerHTML = '';
    var caja = el('div', 'sbq-imp-opciones');

    function check(id, etiqueta, ayuda) {
      var l = el('label', 'sbq-check');
      var c = doc.createElement('input');
      c.type = 'checkbox';
      c.checked = opciones[id];
      c.onchange = function () { opciones[id] = c.checked; dibujar(); };
      l.appendChild(c);
      l.appendChild(el('span', null, esc(etiqueta)));
      if (ayuda) l.title = ayuda;
      caja.appendChild(l);
    }

    if (modo === 'formulario') {
      check('instrucciones', 'Instrucciones de salto',
            'Traduce las condiciones a texto: «Responde solo si en la 5 marcaste…»');
      check('todasLasRamas', 'Incluir todas las ramas',
            'Sin esto solo se imprimen las preguntas que se ven siempre.');
    } else {
      check('vacias', 'Mostrar preguntas sin responder');
    }
    refs.opciones.appendChild(caja);
  }

  // ============================================================= FORMULARIO ==

  function dibujar() {
    refs.hoja.innerHTML = '';
    if (modo === 'formulario') formulario();
    else respuestas();
  }

  /** Numeración corrida de las preguntas, para poder referirlas en los saltos. */
  function numerar(sv) {
    var nums = {}, i = 0;
    Model.eachQuestion(sv, function (q) {
      if (Model.DISPLAY_TYPES.indexOf(q.type) >= 0) return;
      if (q.type === 'expression') return;
      nums[q.id] = ++i;
    });
    return nums;
  }

  function formulario() {
    var nums = numerar(survey);
    var hoja = el('article', 'sbq-doc');

    hoja.appendChild(encabezado(txt(survey.title),
      txt(survey.description), true));

    survey.pages.forEach(function (page) {
      var sec = el('section', 'sbq-doc-seccion');
      if (page.title) sec.appendChild(el('h2', 'sbq-doc-h2', esc(txt(page.title))));
      if (page.description) sec.appendChild(el('p', 'sbq-doc-desc', esc(txt(page.description))));

      var salto = opciones.instrucciones &&
        Model.explicarCondicion(page.visibleIf, survey, nums, survey.locale);
      if (salto) sec.appendChild(el('p', 'sbq-doc-salto', '↳ ' + esc(salto.replace('Responde', 'Responde esta sección'))));

      Model.flatten(page.elements).forEach(function (q) {
        if (!opciones.todasLasRamas && q.visibleIf) return;
        var n = sec.appendChild(preguntaPapel(q, nums));
      });
      hoja.appendChild(sec);
    });

    hoja.appendChild(pie());
    refs.hoja.appendChild(hoja);
    refs.aviso.textContent = Object.keys(nums).length + ' preguntas';
  }

  function encabezado(titulo, sub, conCampos) {
    var h = el('header', 'sbq-doc-cab');
    var fila = el('div', 'sbq-doc-cab-fila');
    var izq = el('div');
    izq.appendChild(el('h1', 'sbq-doc-h1', esc(titulo)));
    if (sub) izq.appendChild(el('p', 'sbq-doc-desc', esc(sub)));
    fila.appendChild(izq);

    var meta = el('div', 'sbq-doc-meta');
    var cc = survey.variables && survey.variables.centro_comercial;
    if (cc) meta.appendChild(el('div', null, esc(cc)));
    meta.appendChild(el('div', 'sbq-doc-meta-tenue',
      'v' + survey.version));
    fila.appendChild(meta);
    h.appendChild(fila);

    if (conCampos) {
      // Datos que en la encuesta digital vienen del QR y en papel los anota
      // quien administra el formulario.
      var campos = el('div', 'sbq-doc-campos');
      ['Fecha', 'Hora', 'Ubicación', 'Encuestador'].forEach(function (c) {
        var d = el('div', 'sbq-doc-campo');
        d.appendChild(el('span', null, esc(c)));
        d.appendChild(el('span', 'sbq-linea', ''));
        campos.appendChild(d);
      });
      h.appendChild(campos);
    }
    return h;
  }

  function pie() {
    var p = el('footer', 'sbq-doc-pie');
    p.appendChild(el('span', null, esc(txt(survey.title)) + ' · ' +
      esc(survey.variables && survey.variables.centro_comercial || '')));
    p.appendChild(el('span', null, 'Generado el ' + new Date().toLocaleDateString('es-CL')));
    return p;
  }

  /** Una pregunta como control de papel. */
  function preguntaPapel(q, nums) {
    var wrap = el('div', 'sbq-doc-q');

    if (q.type === 'html') {
      wrap.className = 'sbq-doc-nota';
      wrap.innerHTML = txt(q.html);
      return wrap;
    }
    if (q.type === 'panel') {
      wrap.className = 'sbq-doc-grupo';
      if (q.title) wrap.appendChild(el('div', 'sbq-doc-grupo-tit', esc(txt(q.title))));
      return wrap;
    }
    if (q.type === 'expression') return el('div', 'sbq-hidden');

    var cab = el('div', 'sbq-doc-q-cab');
    cab.appendChild(el('span', 'sbq-doc-num', String(nums[q.id])));
    var tit = el('span', 'sbq-doc-q-tit', esc(txt(q.title) || q.id));
    if (q.required) tit.appendChild(el('span', 'sbq-doc-obl', ' *'));
    cab.appendChild(tit);
    wrap.appendChild(cab);

    if (q.description) wrap.appendChild(el('div', 'sbq-doc-q-desc', esc(txt(q.description))));

    var salto = opciones.instrucciones &&
      Model.explicarCondicion(q.visibleIf, survey, nums, survey.locale);
    if (salto) wrap.appendChild(el('div', 'sbq-doc-salto', '↳ ' + esc(salto)));

    wrap.appendChild(controlPapel(q));
    return wrap;
  }

  function controlPapel(q) {
    var c = el('div', 'sbq-doc-control');

    switch (q.type) {
      case 'rating': {
        var esc2 = el('div', 'sbq-doc-escala');
        for (var v = q.rateMin; v <= q.rateMax; v += (q.rateStep || 1)) {
          var casilla = el('div', 'sbq-doc-escala-item');
          casilla.appendChild(el('span', 'sbq-doc-circulo', ''));
          casilla.appendChild(el('span', 'sbq-doc-escala-num', String(v)));
          esc2.appendChild(casilla);
        }
        c.appendChild(esc2);
        if (q.minLabel || q.maxLabel) {
          var lbl = el('div', 'sbq-doc-escala-lbl');
          lbl.appendChild(el('span', null, esc(txt(q.minLabel))));
          lbl.appendChild(el('span', null, esc(txt(q.maxLabel))));
          c.appendChild(lbl);
        }
        break;
      }

      case 'radio': case 'dropdown': case 'checkbox': case 'tagbox': case 'imagepicker': {
        var lista = el('div', 'sbq-doc-opciones' +
          ((q.choices || []).length > 5 ? ' es-columnas' : ''));
        (q.choices || []).forEach(function (op) {
          var o = el('div', 'sbq-doc-opcion');
          o.appendChild(el('span', q.type === 'radio' || q.type === 'dropdown'
            ? 'sbq-doc-circulo' : 'sbq-doc-cuadro', ''));
          o.appendChild(el('span', null, esc(txt(op.text))));
          lista.appendChild(o);
        });
        if (q.hasOther) {
          var o2 = el('div', 'sbq-doc-opcion es-otro');
          o2.appendChild(el('span', 'sbq-doc-cuadro', ''));
          o2.appendChild(el('span', null, esc(txt(q.otherText) || 'Otro') + ' '));
          o2.appendChild(el('span', 'sbq-linea', ''));
          lista.appendChild(o2);
        }
        c.appendChild(lista);
        break;
      }

      case 'ranking': {
        var r = el('div', 'sbq-doc-opciones');
        r.appendChild(el('div', 'sbq-doc-q-desc',
          'Numera del 1 al ' + (q.choices || []).length + ' según tu preferencia.'));
        (q.choices || []).forEach(function (op) {
          var o = el('div', 'sbq-doc-opcion');
          o.appendChild(el('span', 'sbq-doc-caja-num', ''));
          o.appendChild(el('span', null, esc(txt(op.text))));
          r.appendChild(o);
        });
        c.appendChild(r);
        break;
      }

      case 'matrix': {
        var t = el('table', 'sbq-doc-matriz');
        var thead = doc.createElement('thead');
        var trh = doc.createElement('tr');
        trh.appendChild(el('th', null, ''));
        (q.columns || []).forEach(function (col) {
          trh.appendChild(el('th', null, esc(txt(col.text))));
        });
        thead.appendChild(trh);
        t.appendChild(thead);

        var tb = doc.createElement('tbody');
        (q.rows || []).forEach(function (fila) {
          var tr = doc.createElement('tr');
          tr.appendChild(el('th', 'sbq-doc-matriz-fila', esc(txt(fila.text))));
          (q.columns || []).forEach(function () {
            var td = doc.createElement('td');
            td.appendChild(el('span', 'sbq-doc-circulo', ''));
            tr.appendChild(td);
          });
          tb.appendChild(tr);
        });
        t.appendChild(tb);
        c.appendChild(t);
        break;
      }

      case 'multipletext': {
        (q.items || []).forEach(function (it) {
          var d = el('div', 'sbq-doc-campo');
          d.appendChild(el('span', null, esc(txt(it.title))));
          d.appendChild(el('span', 'sbq-linea', ''));
          c.appendChild(d);
        });
        break;
      }

      case 'comment': {
        var n = Math.max(2, Math.min(6, q.rows || 3));
        for (var i = 0; i < n; i++) c.appendChild(el('div', 'sbq-linea es-sola', ''));
        break;
      }

      case 'boolean': {
        var b = el('div', 'sbq-doc-opciones');
        [q.trueText || 'Sí', q.falseText || 'No'].forEach(function (etq) {
          var o = el('div', 'sbq-doc-opcion');
          o.appendChild(el('span', 'sbq-doc-circulo', ''));
          o.appendChild(el('span', null, esc(etq)));
          b.appendChild(o);
        });
        c.appendChild(b);
        break;
      }

      case 'file': case 'signature': {
        var caja = el('div', 'sbq-doc-caja');
        caja.textContent = q.type === 'file'
          ? 'Adjuntar aparte' : 'Firma';
        c.appendChild(caja);
        break;
      }

      default:
        c.appendChild(el('div', 'sbq-linea es-sola', ''));
    }
    return c;
  }

  // ============================================================= RESPUESTAS ==

  function respuestas() {
    var lista = SBQ.storage.listResponses(survey.id);
    refs.aviso.textContent = lista.length + ' respuestas en este navegador';

    if (!lista.length) {
      var v = el('div', 'sbq-doc sbq-vacio-datos');
      v.appendChild(el('h2', null, 'No hay respuestas guardadas'));
      v.appendChild(el('p', 'sbq-muted',
        'Responde la encuesta o carga un archivo en el panel. Para imprimir el ' +
        'formulario en blanco, cambia el modo arriba.'));
      refs.hoja.appendChild(v);
      return;
    }

    var nums = numerar(survey);
    lista.slice().reverse().forEach(function (r) {
      refs.hoja.appendChild(hojaRespuesta(r, nums));
    });
  }

  function hojaRespuesta(r, nums) {
    var hoja = el('article', 'sbq-doc es-respuesta');
    var fila = SBQ.bigquery.toRow(r);

    var cab = el('header', 'sbq-doc-cab');
    var f1 = el('div', 'sbq-doc-cab-fila');
    var izq = el('div');
    izq.appendChild(el('h1', 'sbq-doc-h1', esc(txt(survey.title))));
    izq.appendChild(el('p', 'sbq-doc-desc',
      esc([fila.centro_comercial, fila.touchpoint, fila.sector_contexto]
        .filter(Boolean).join(' · '))));
    f1.appendChild(izq);

    var meta = el('div', 'sbq-doc-meta');
    meta.appendChild(el('div', null, esc(String(r.started_at).slice(0, 16).replace('T', ' '))));
    meta.appendChild(el('div', 'sbq-doc-meta-tenue', esc(r.response_id.slice(0, 8))));
    f1.appendChild(meta);
    cab.appendChild(f1);
    hoja.appendChild(cab);

    // Cabecera de datos: lo que se mira primero al abrir un caso.
    var res = el('div', 'sbq-doc-resumen');
    function dato(etq, val, destacado) {
      if (val === null || val === undefined || val === '') return;
      var d = el('div', 'sbq-doc-dato' + (destacado ? ' es-destacado' : ''));
      d.appendChild(el('span', 'sbq-doc-dato-etq', esc(etq)));
      d.appendChild(el('span', 'sbq-doc-dato-val', esc(String(val))));
      res.appendChild(d);
    }
    if (fila.score != null) {
      dato(fila.score_type, fila.score + (fila.score_bucket ? ' · ' + fila.score_bucket : ''), true);
    }
    dato('Palanca', fila.palanca);
    dato('Estado', { completed: 'Completada', partial: 'Abandonada',
                     disqualified: 'Fuera de perfil' }[fila.status] || fila.status);
    dato('Duración', fila.duracion_seg + ' s');
    dato('Canal', fila.canal);
    if (res.children.length) hoja.appendChild(res);

    // Detalle pregunta a pregunta.
    var cuerpo = el('div', 'sbq-doc-seccion');
    var respondidas = {};
    (r.answers || []).forEach(function (a) { respondidas[a.question_id] = a; });

    Model.eachQuestion(survey, function (q) {
      if (Model.DISPLAY_TYPES.indexOf(q.type) >= 0) return;
      var a = respondidas[q.id];
      if (!a && !opciones.vacias) return;

      var d = el('div', 'sbq-doc-r');
      var cabQ = el('div', 'sbq-doc-q-cab');
      // Los valores calculados no se numeran: en papel nadie los responde,
      // así que no tienen número al cual referirse.
      if (nums[q.id]) cabQ.appendChild(el('span', 'sbq-doc-num', String(nums[q.id])));
      else cabQ.appendChild(el('span', 'sbq-doc-num es-calculado', 'ƒ'));
      cabQ.appendChild(el('span', 'sbq-doc-q-tit', esc(txt(q.title) || q.id)));
      d.appendChild(cabQ);

      var valor = el('div', 'sbq-doc-r-val');
      if (!a) {
        valor.className += ' es-vacia';
        valor.textContent = 'Sin responder';
      } else {
        var v = a.value_text;
        if (Array.isArray(v)) {
          var ul = doc.createElement('ul');
          ul.className = 'sbq-doc-lista';
          v.forEach(function (x) { ul.appendChild(el('li', null, esc(String(x)))); });
          valor.appendChild(ul);
        } else {
          valor.textContent = String(v);
        }
        if (a.other_text) {
          valor.appendChild(el('div', 'sbq-doc-otro', 'Otro: ' + esc(a.other_text)));
        }
      }
      d.appendChild(valor);
      cuerpo.appendChild(d);
    });
    hoja.appendChild(cuerpo);

    // Los adjuntos van como imagen cuando se puede: en una impresión para
    // operaciones, la foto del baño es la mitad del valor del reporte.
    (r.attachments || []).forEach(function (adj) {
      var q = Model.findQuestion(survey, adj.question_id);
      var caja = el('div', 'sbq-doc-adjuntos');
      caja.appendChild(el('div', 'sbq-doc-dato-etq', esc(txt(q && q.title) || adj.question_id)));

      (adj.archivos || []).forEach(function (f) {
        if (f.dataUrl && /^image\//.test(f.type || '')) {
          var img = doc.createElement('img');
          img.src = f.dataUrl;
          img.alt = f.name;
          img.className = 'sbq-doc-foto';
          caja.appendChild(img);
        } else {
          caja.appendChild(el('div', 'sbq-muted', esc(f.name)));
        }
      });
      if (adj.firma) {
        var s = doc.createElement('img');
        s.src = adj.firma;
        s.alt = 'Firma';
        s.className = 'sbq-doc-firma';
        caja.appendChild(s);
      }
      hoja.appendChild(caja);
    });

    hoja.appendChild(pie());
    return hoja;
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot);
  else boot();

})(typeof window !== 'undefined' ? window : globalThis);
