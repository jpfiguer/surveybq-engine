/*!
 * surveyBQ — editor.js
 * Editor visual de encuestas, en cinco pestañas:
 *
 *   Diseñador     árbol, caja de herramientas, vista previa y propiedades
 *   Lógica        todas las reglas de la encuesta, con constructor visual
 *   Traducciones  tabla de textos por idioma
 *   Tema          apariencia, guardada dentro de la encuesta
 *   JSON          la definición cruda, para pegar o revisar
 *
 * Los cambios se guardan como borrador en el navegador y el respondedor los
 * toma de inmediato. Exportar deja el archivo para versionar en el repositorio.
 */
(function (global) {
  'use strict';

  var SBQ = global.SBQ;
  var doc = global.document;
  var Model = SBQ.Model;
  var Expr = SBQ.Expression;
  var util = SBQ.util;
  var el = SBQ.render.el;
  var esc = util.esc;

  // ------------------------------------------------------------------ estado

  var survey = null;      // encuesta en edición (normalizada)
  var baseId = null;      // id original, para guardar y restaurar
  var sel = null;         // { tipo:'page'|'question', pageIndex, ruta:[índices] }
  var tab = 'disenador';
  var previewRt = null;
  var previewPage = 0;
  var previewLocale = null;
  var refs = {};

  /* Historial de deshacer. Se guardan instantáneas completas en JSON: la
     encuesta más grande ronda los 200 KB y el navegador aguanta de sobra 50
     de esas, así que no vale la pena un sistema de parches. */
  var historial = { pila: [], pos: -1, limite: 50 };

  var TABS = [
    { id: 'disenador',    texto: 'Diseñador' },
    { id: 'logica',       texto: 'Lógica' },
    { id: 'traducciones', texto: 'Traducciones' },
    { id: 'tema',         texto: 'Tema' },
    { id: 'json',         texto: 'JSON' }
  ];

  // ------------------------------------------------------------------ inicio

  function boot() {
    ['tree', 'props', 'preview', 'issues', 'picker', 'status', 'toolbox',
     'logica', 'traducciones', 'tema', 'json', 'tabs'].forEach(function (k) {
      refs[k] = doc.getElementById('sbq-' + k);
    });

    // Publicado en la web, el editor pide clave antes de mostrarse. En local
    // (sin endpoint configurado) se abre directo, como siempre.
    var url = (SBQ.config && SBQ.config.encuestasEndpoint) || '';
    if (url && !sesionClave()) { pantallaClave(); return; }
    seguirArrancando();
  }

  // ------------------------------------------------------------ acceso

  function sesionClave() {
    try { return global.sessionStorage.getItem('sbq:editor:clave') || ''; }
    catch (e) { return ''; }
  }
  function guardarClave(c) {
    try {
      if (c) global.sessionStorage.setItem('sbq:editor:clave', c);
      else global.sessionStorage.removeItem('sbq:editor:clave');
    } catch (e) {}
  }

  /** Pide la clave del editor y la valida contra el servidor. */
  function pantallaClave(aviso) {
    var cuerpo = doc.querySelector('.sbq-editor') || doc.body;
    cuerpo.innerHTML = '';
    var card = doc.createElement('div');
    card.className = 'sbq-g sbq-clave-card';
    card.innerHTML =
      '<h2>Editor de encuestas</h2>' +
      '<p class="sbq-muted">Ingresa la clave de edición. Es distinta de la del panel: ' +
      'acá se cambia lo que se le pregunta a la gente.</p>' +
      (aviso ? '<p class="sbq-clave-error"></p>' : '');
    if (aviso) card.querySelector('.sbq-clave-error').textContent = aviso;

    var form = doc.createElement('form');
    form.className = 'sbq-clave-form';
    var inp = doc.createElement('input');
    inp.type = 'password'; inp.className = 'sbq-input';
    inp.placeholder = 'Clave de edición'; inp.autocomplete = 'current-password';
    var btn = doc.createElement('button');
    btn.className = 'sbq-btn sbq-btn-primary'; btn.type = 'submit'; btn.textContent = 'Entrar';
    form.appendChild(inp); form.appendChild(btn);

    form.onsubmit = function (e) {
      e.preventDefault();
      if (!inp.value) return;
      btn.disabled = true; btn.textContent = 'Verificando…';
      // Mismo motivo que en el panel: el servicio arranca al recibir la primera
      // consulta del día, así que un fallo pasajero no debe leerse como
      // "clave incorrecta". Solo el 401 lo es.
      var esperas = [0, 2000, 6000];
      (function intentar(n) {
        global.fetch(SBQ.config.encuestasEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-SBQ-Clave': inp.value },
          body: JSON.stringify({ accion: 'validar' })
        }).then(function (r) {
          if (r.status === 401) throw new Error('mala');
          if (!r.ok) throw new Error('http');
          guardarClave(inp.value);
          global.location.reload();
        }).catch(function (err) {
          if (err.message !== 'mala' && n < esperas.length - 1) {
            btn.textContent = 'Reintentando… (' + (n + 2) + ' de ' + esperas.length + ')';
            global.setTimeout(function () { intentar(n + 1); }, esperas[n + 1]);
            return;
          }
          btn.disabled = false; btn.textContent = 'Entrar';
          pantallaClave(err.message === 'mala'
            ? 'Clave incorrecta.'
            : 'El servidor no responde. Vuelve a intentar en un minuto: la primera ' +
              'consulta del día tarda más porque el servicio arranca al recibirla.');
        });
      })(0);
    };
    card.appendChild(form);
    cuerpo.appendChild(card);
    inp.focus();
  }

  function seguirArrancando() {

    var ids = Object.keys(SBQ.surveys);
    ids.forEach(function (id) {
      var o = doc.createElement('option');
      o.value = id;
      o.textContent = SBQ.surveys[id].title;
      refs.picker.appendChild(o);
    });

    var pedido = util.queryParams().survey;
    var inicial = ids.indexOf(pedido) >= 0 ? pedido : ids[0];
    refs.picker.value = inicial;
    refs.picker.onchange = function () { cargar(refs.picker.value); };

    doc.getElementById('btn-guardar').onclick   = guardar;
    var btnPub = doc.getElementById('btn-publicar');
    if (btnPub) {
      // Solo tiene sentido con el servicio configurado; en local se esconde.
      if (SBQ.config && SBQ.config.encuestasEndpoint) btnPub.onclick = publicar;
      else btnPub.style.display = 'none';
    }
    doc.getElementById('btn-restaurar').onclick = restaurar;
    doc.getElementById('btn-json').onclick      = function () { exportar('json'); };
    doc.getElementById('btn-js').onclick        = function () { exportar('js'); };
    doc.getElementById('btn-importar').onclick  = importar;
    doc.getElementById('btn-pagina').onclick    = agregarPagina;
    doc.getElementById('btn-deshacer').onclick  = deshacer;
    doc.getElementById('btn-rehacer').onclick   = rehacer;
    doc.getElementById('btn-json-aplicar').onclick = aplicarJSON;
    doc.getElementById('btn-responder').onclick = function () {
      guardar();
      global.open('responder.html?survey=' + encodeURIComponent(survey.id), '_blank');
    };

    doc.addEventListener('keydown', atajos);
    dibujarTabs();
    cargar(inicial);
  }

  function atajos(e) {
    var meta = e.metaKey || e.ctrlKey;
    if (!meta) return;
    var k = (e.key || '').toLowerCase();

    // En un campo de texto, deshacer es del propio campo.
    var dentroDeCampo = /^(input|textarea|select)$/i.test((e.target.tagName || ''));

    if (k === 'z' && !dentroDeCampo) {
      e.preventDefault();
      if (e.shiftKey) rehacer(); else deshacer();
    }
    if (k === 's') { e.preventDefault(); guardar(); }
  }

  function cargar(id) {
    baseId = id;
    survey = Model.normalize(SBQ.getSurvey(id));
    sel = survey.pages.length ? { tipo: 'page', pageIndex: 0 } : null;
    previewPage = 0;
    previewRt = null;
    previewLocale = null;
    historial = { pila: [JSON.stringify(survey)], pos: 0, limite: 50 };
    refrescar();
  }

  // --------------------------------------------------------------- historial

  /**
   * Guarda una instantánea. Se llama DESPUÉS de aplicar el cambio, así que la
   * pila siempre arranca con el estado inicial y cada entrada es un estado
   * al que se puede volver.
   */
  function marcar() {
    var ahora = JSON.stringify(survey);
    if (historial.pila[historial.pos] === ahora) return;

    historial.pila = historial.pila.slice(0, historial.pos + 1);
    historial.pila.push(ahora);
    if (historial.pila.length > historial.limite) historial.pila.shift();
    historial.pos = historial.pila.length - 1;
    actualizarHistorialUI();
  }

  function deshacer() {
    if (historial.pos <= 0) return;
    historial.pos--;
    survey = JSON.parse(historial.pila[historial.pos]);
    previewRt = null;
    validarSeleccion();
    refrescar();
    toast('Deshecho');
  }

  function rehacer() {
    if (historial.pos >= historial.pila.length - 1) return;
    historial.pos++;
    survey = JSON.parse(historial.pila[historial.pos]);
    previewRt = null;
    validarSeleccion();
    refrescar();
    toast('Rehecho');
  }

  function actualizarHistorialUI() {
    doc.getElementById('btn-deshacer').disabled = historial.pos <= 0;
    doc.getElementById('btn-rehacer').disabled = historial.pos >= historial.pila.length - 1;
  }

  /** Tras deshacer, lo seleccionado puede haber dejado de existir. */
  function validarSeleccion() {
    if (!sel) return;
    if (!survey.pages[sel.pageIndex]) {
      sel = survey.pages.length ? { tipo: 'page', pageIndex: 0 } : null;
      return;
    }
    if (sel.tipo === 'question' && !preguntaEn(sel)) {
      sel = { tipo: 'page', pageIndex: sel.pageIndex };
    }
  }

  // ------------------------------------------------------------------ rutas
  // Una pregunta se ubica por página + ruta de índices, para poder entrar en
  // los grupos anidados sin depender de los ids.

  function contenedorDe(s) {
    var nodo = survey.pages[s.pageIndex];
    if (!nodo) return null;
    for (var i = 0; i < s.ruta.length - 1; i++) {
      nodo = nodo.elements && nodo.elements[s.ruta[i]];
      if (!nodo) return null;
    }
    return nodo;
  }

  function preguntaEn(s) {
    var cont = contenedorDe(s);
    if (!cont || !cont.elements) return null;
    return cont.elements[s.ruta[s.ruta.length - 1]] || null;
  }

  function seleccionada() {
    return sel && sel.tipo === 'question' ? preguntaEn(sel) : null;
  }

  function mismaRuta(a, b) {
    return a && b && a.length === b.length && a.every(function (x, i) { return x === b[i]; });
  }

  // -------------------------------------------------------------- pestañas

  function dibujarTabs() {
    refs.tabs.innerHTML = '';
    TABS.forEach(function (t) {
      var b = el('button', 'sbq-tab' + (t.id === tab ? ' is-on' : ''), esc(t.texto));
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', t.id === tab ? 'true' : 'false');
      b.onclick = function () { irA(t.id); };
      refs.tabs.appendChild(b);
    });
  }

  function irA(id) {
    tab = id;
    TABS.forEach(function (t) {
      doc.getElementById('tab-' + t.id).classList.toggle('sbq-hidden', t.id !== id);
    });
    dibujarTabs();
    refrescar();
  }

  function refrescar() {
    dibujarEstado();
    actualizarHistorialUI();

    if (tab === 'disenador') {
      dibujarArbol();
      dibujarToolbox();
      dibujarProps();
      dibujarPreview();
      dibujarIssues();
    }
    if (tab === 'logica') dibujarLogica();
    if (tab === 'traducciones') dibujarTraducciones();
    if (tab === 'tema') dibujarTema();
    if (tab === 'json') dibujarJSON();
  }

  function toast(msg) {
    var t = doc.getElementById('sbq-toast');
    t.textContent = msg;
    t.classList.add('is-on');
    clearTimeout(t._t);
    t._t = setTimeout(function () { t.classList.remove('is-on'); }, 2200);
  }

  function dibujarEstado() {
    var info = SBQ.storage.draftInfo(survey.id);
    refs.status.innerHTML = '';
    if (info) {
      refs.status.appendChild(el('span', 'sbq-badge is-warn',
        'Borrador · ' + new Date(info.savedAt).toLocaleString('es-CL')));
    } else {
      refs.status.appendChild(el('span', 'sbq-badge', 'Versión original'));
    }
    var n = Model.allQuestions(survey)
      .filter(function (q) { return Model.DISPLAY_TYPES.indexOf(q.type) < 0; }).length;
    refs.status.appendChild(el('span', 'sbq-badge', survey.pages.length + 'p · ' + n + 'q'));
  }

  /** Todo cambio pasa por acá: aplica, marca en el historial y redibuja. */
  function cambio(fn, redibujarTodo) {
    fn();
    marcar();
    dibujarPreview();
    dibujarIssues();
    dibujarEstado();
    dibujarArbol();
    if (redibujarTodo) dibujarProps();
  }

  // =========================================================== DISEÑADOR ===

  /** Caja de herramientas: un botón por tipo, arrastrable al árbol. */
  function dibujarToolbox() {
    if (!refs.toolbox) return;
    refs.toolbox.innerHTML = '';

    Model.ALL_TYPES.forEach(function (t) {
      var b = el('button', 'sbq-tool');
      b.type = 'button';
      b.draggable = true;
      b.title = 'Agregar: ' + (Model.TYPE_LABELS[t] || t);
      b.appendChild(el('span', 'sbq-tool-icon', ICONOS[t] || '▫'));
      b.appendChild(el('span', 'sbq-tool-txt', esc(Model.TYPE_LABELS[t] || t)));
      b.onclick = function () { agregarPregunta(t); };
      b.ondragstart = function (e) {
        e.dataTransfer.setData('text/sbq-tipo', t);
        e.dataTransfer.effectAllowed = 'copy';
      };
      refs.toolbox.appendChild(b);
    });
  }

  var ICONOS = {
    rating: '★', radio: '◉', checkbox: '☑', dropdown: '▾', tagbox: '🏷',
    text: 'Ab', comment: '¶', boolean: '⇄', matrix: '▦', ranking: '↕',
    multipletext: '⋮⋮', imagepicker: '🖼', file: '📎', signature: '✍',
    panel: '▤', expression: 'ƒ', html: '</>'
  };

  // ------------------------------------------------------------------ árbol

  function dibujarArbol() {
    if (!refs.tree) return;
    refs.tree.innerHTML = '';
    var arrastrando = null;   // { pageIndex, ruta }

    survey.pages.forEach(function (page, pi) {
      var li = el('li', 'sbq-tree-page');

      var label = el('div', 'sbq-tree-label' +
        (sel && sel.tipo === 'page' && sel.pageIndex === pi ? ' is-active' : ''));
      label.appendChild(el('span', null, '📄'));
      label.appendChild(el('span', 'sbq-tree-txt', esc(textoPlano(page.title) || page.id)));
      if (page.visibleIf)    label.appendChild(el('span', 'sbq-tree-cond', '🔀'));
      if (page.disqualifyIf) label.appendChild(el('span', 'sbq-tree-cond', '⛔'));
      label.onclick = function () { sel = { tipo: 'page', pageIndex: pi }; refrescar(); };
      li.appendChild(label);

      var ul = el('ul', 'sbq-tree-items');
      pintarElementos(ul, page.elements, pi, [], 0);
      li.appendChild(ul);
      refs.tree.appendChild(li);
    });

    /** Dibuja una lista de elementos, entrando en los grupos. */
    function pintarElementos(ul, elementos, pi, prefijo, nivel) {
      (elementos || []).forEach(function (q, qi) {
        var ruta = prefijo.concat([qi]);
        var activo = sel && sel.tipo === 'question' && sel.pageIndex === pi &&
                     mismaRuta(sel.ruta, ruta);

        var item = el('li', 'sbq-tree-item' + (activo ? ' is-active' : ''));
        item.style.paddingLeft = (8 + nivel * 12) + 'px';
        item.draggable = true;

        item.appendChild(el('span', 'sbq-tree-type', ICONOS[q.type] || '▫'));
        item.appendChild(el('span', 'sbq-tree-txt',
          esc(textoPlano(q.title) || textoPlano(q.html) || q.id)));
        if (q.visibleIf) item.appendChild(el('span', 'sbq-tree-cond', '🔀'));
        if (q.required)  item.appendChild(el('span', 'sbq-tree-cond', '*'));

        item.onclick = function (e) {
          e.stopPropagation();
          sel = { tipo: 'question', pageIndex: pi, ruta: ruta };
          previewPage = pi;
          refrescar();
        };

        // Reordenar arrastrando dentro del árbol.
        item.ondragstart = function (e) {
          e.stopPropagation();
          arrastrando = { pageIndex: pi, ruta: ruta };
          item.classList.add('is-dragging');
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', q.id);
        };
        item.ondragend = function () { item.classList.remove('is-dragging'); };
        item.ondragover = function (e) { e.preventDefault(); item.classList.add('is-over'); };
        item.ondragleave = function () { item.classList.remove('is-over'); };
        item.ondrop = function (e) {
          e.preventDefault();
          e.stopPropagation();
          item.classList.remove('is-over');

          var tipoNuevo = e.dataTransfer.getData('text/sbq-tipo');
          if (tipoNuevo) { agregarPregunta(tipoNuevo, { pageIndex: pi, ruta: ruta }); return; }
          if (!arrastrando) return;
          moverPorArrastre(arrastrando, { pageIndex: pi, ruta: ruta });
          arrastrando = null;
        };

        ul.appendChild(item);

        if (q.type === 'panel') {
          var sub = el('ul', 'sbq-tree-items');
          pintarElementos(sub, q.elements, pi, ruta, nivel + 1);
          if (!q.elements || !q.elements.length) {
            var vacio = el('li', 'sbq-tree-item sbq-muted');
            vacio.style.paddingLeft = (8 + (nivel + 1) * 12) + 'px';
            vacio.appendChild(el('span', 'sbq-tree-txt', 'grupo vacío'));
            sub.appendChild(vacio);
          }
          ul.appendChild(sub);
        }
      });

      // Zona para soltar al final de la lista.
      var fin = el('li', 'sbq-tree-drop');
      fin.style.marginLeft = (8 + nivel * 12) + 'px';
      fin.textContent = '+ soltar aquí';
      fin.ondragover = function (e) { e.preventDefault(); fin.classList.add('is-over'); };
      fin.ondragleave = function () { fin.classList.remove('is-over'); };
      fin.ondrop = function (e) {
        e.preventDefault();
        fin.classList.remove('is-over');
        var destino = { pageIndex: pi, ruta: prefijo.concat([(elementos || []).length]) };
        var tipoNuevo = e.dataTransfer.getData('text/sbq-tipo');
        if (tipoNuevo) { agregarPregunta(tipoNuevo, destino, true); return; }
        if (!arrastrando) return;
        moverPorArrastre(arrastrando, destino, true);
        arrastrando = null;
      };
      ul.appendChild(fin);
    }
  }

  /** Título sin etiquetas HTML ni objetos de idioma, para el árbol. */
  function textoPlano(v) {
    var t = Model.localized(v, survey.locale, survey.locale);
    return String(t == null ? '' : t).replace(/<[^>]+>/g, '').trim();
  }

  function moverPorArrastre(desde, hasta, alFinal) {
    if (desde.pageIndex === hasta.pageIndex && mismaRuta(desde.ruta, hasta.ruta)) return;

    // No se puede soltar un grupo dentro de sí mismo.
    if (desde.pageIndex === hasta.pageIndex &&
        desde.ruta.every(function (x, i) { return hasta.ruta[i] === x; }) &&
        hasta.ruta.length > desde.ruta.length) {
      toast('Un grupo no puede ir dentro de sí mismo.');
      return;
    }

    cambio(function () {
      var contOrigen = contenedorDe(desde);
      var q = contOrigen.elements.splice(desde.ruta[desde.ruta.length - 1], 1)[0];

      var contDestino = contenedorDe(hasta);
      var idx = hasta.ruta[hasta.ruta.length - 1];
      // Si salió de antes en la misma lista, el índice se corrió.
      if (contOrigen === contDestino && desde.ruta[desde.ruta.length - 1] < idx) idx--;
      contDestino.elements.splice(alFinal ? contDestino.elements.length : idx, 0, q);

      sel = { tipo: 'question', pageIndex: hasta.pageIndex,
              ruta: hasta.ruta.slice(0, -1).concat([
                alFinal ? contDestino.elements.length - 1 : idx]) };
    }, true);
  }

  // ------------------------------------------------------------- controles

  function campo(label, control, ayuda) {
    var f = el('div', 'sbq-field');
    if (label) f.appendChild(el('label', null, esc(label)));
    f.appendChild(control);
    if (ayuda) f.appendChild(el('div', 'sbq-help', ayuda));
    return f;
  }

  function inputTexto(valor, onChange, placeholder, mono) {
    var i = doc.createElement('input');
    i.type = 'text';
    i.className = 'sbq-input' + (mono ? ' sbq-code' : '');
    i.value = valor == null ? '' : valor;
    if (placeholder) i.placeholder = placeholder;
    i.oninput = function () { onChange(i.value); };
    return i;
  }

  function areaTexto(valor, onChange, rows, mono) {
    var t = doc.createElement('textarea');
    t.className = 'sbq-textarea' + (mono ? ' sbq-code' : '');
    t.rows = rows || 3;
    t.value = valor == null ? '' : valor;
    t.oninput = function () { onChange(t.value); };
    return t;
  }

  function casilla(label, valor, onChange) {
    var l = el('label', 'sbq-check');
    var c = doc.createElement('input');
    c.type = 'checkbox';
    c.checked = !!valor;
    c.onchange = function () { onChange(c.checked); };
    l.appendChild(c);
    l.appendChild(el('span', null, esc(label)));
    return l;
  }

  function selectCampo(valor, opciones, onChange) {
    var s = doc.createElement('select');
    s.className = 'sbq-select';
    opciones.forEach(function (o) {
      var op = doc.createElement('option');
      op.value = o.value;
      op.textContent = o.text;
      if (String(o.value) === String(valor)) op.selected = true;
      s.appendChild(op);
    });
    s.onchange = function () { onChange(s.value); };
    return s;
  }

  /**
   * Campo de texto que respeta el multi-idioma: edita el idioma base y deja
   * intactas las demás traducciones, que se manejan en su propia pestaña.
   */
  function campoTexto(obj, prop, opts) {
    opts = opts || {};
    var actual = obj[prop];
    var esObjeto = actual && typeof actual === 'object' && !Array.isArray(actual);
    var base = survey.locale || 'es';
    var valor = esObjeto ? (actual[base] || '') : (actual || '');

    var control = opts.largo
      ? areaTexto(valor, aplicar, opts.rows || 3, opts.mono)
      : inputTexto(valor, aplicar, opts.placeholder, opts.mono);

    function aplicar(v) {
      cambio(function () {
        if (esObjeto) {
          if (v === '') delete obj[prop][base];
          else obj[prop][base] = v;
          if (!Object.keys(obj[prop]).length) delete obj[prop];
        } else if (v === '') {
          delete obj[prop];
        } else {
          obj[prop] = v;
        }
      });
    }

    if (!esObjeto) return control;

    var wrap = el('div');
    wrap.appendChild(control);
    var otros = Object.keys(actual).filter(function (k) { return k !== base; });
    if (otros.length) {
      wrap.appendChild(el('div', 'sbq-help',
        'Traducido a ' + otros.join(', ') + '. Se edita en la pestaña Traducciones.'));
    }
    return wrap;
  }

  function numero(obj, prop, onAfter) {
    return inputTexto(obj[prop], function (v) {
      cambio(function () {
        if (v === '') delete obj[prop];
        else obj[prop] = Number(v);
      }, !!onAfter);
    });
  }

  // ------------------------------------------------------------ propiedades

  function dibujarProps() {
    if (!refs.props) return;
    refs.props.innerHTML = '';

    if (!sel) {
      refs.props.appendChild(el('div', 'sbq-empty', 'Elige una página o una pregunta.'));
      return;
    }
    if (sel.tipo === 'page') return propsPagina(survey.pages[sel.pageIndex]);

    var q = seleccionada();
    if (!q) { sel = { tipo: 'page', pageIndex: sel.pageIndex }; return dibujarProps(); }
    propsPregunta(q);
  }

  function propsPagina(page) {
    if (!page) return;
    var box = refs.props;

    box.appendChild(campo('Identificador', inputTexto(page.id, function (v) {
      cambio(function () { page.id = v || page.id; });
    }, 'pagina1', true), 'Aparece en los reportes. Evita cambiarlo si ya hay respuestas.'));

    box.appendChild(campo('Título', campoTexto(page, 'title')));
    box.appendChild(campo('Descripción', campoTexto(page, 'description', { largo: true, rows: 2 })));
    box.appendChild(campo('Mostrar solo si', condicion(page, 'visibleIf')));
    box.appendChild(campo('Terminar como fuera de perfil si', condicion(page, 'disqualifyIf'),
      'Corta la encuesta al avanzar. Ej.: <code>{visito_6m} = \'No\'</code>'));
    box.appendChild(campo('Terminar (completada) si', condicion(page, 'completeIf')));

    var acciones = el('div', 'sbq-row');
    var arriba = el('button', 'sbq-btn sbq-btn-sm', '↑ Subir');
    arriba.onclick = function () { moverPagina(sel.pageIndex, -1); };
    var abajo = el('button', 'sbq-btn sbq-btn-sm', '↓ Bajar');
    abajo.onclick = function () { moverPagina(sel.pageIndex, 1); };
    var dup = el('button', 'sbq-btn sbq-btn-sm', 'Duplicar');
    dup.onclick = function () {
      cambio(function () {
        var copia = util.clone(page);
        copia.id = page.id + '_copia';
        survey.pages.splice(sel.pageIndex + 1, 0, copia);
        sel = { tipo: 'page', pageIndex: sel.pageIndex + 1 };
      }, true);
    };
    var borrar = el('button', 'sbq-btn sbq-btn-sm sbq-btn-danger', 'Eliminar');
    borrar.onclick = function () {
      if (!global.confirm('¿Eliminar la página «' + (textoPlano(page.title) || page.id) +
                          '» y sus preguntas?')) return;
      cambio(function () {
        survey.pages.splice(sel.pageIndex, 1);
        sel = survey.pages.length ? { tipo: 'page', pageIndex: 0 } : null;
      }, true);
    };
    [arriba, abajo, dup, borrar].forEach(function (b) { acciones.appendChild(b); });
    box.appendChild(acciones);
  }

  function propsPregunta(q) {
    var box = refs.props;

    if (q.reconstruido) {
      box.appendChild(el('div', 'sbq-badge is-warn',
        'Enunciado reconstruido: no venía literal en el archivo fuente.'));
    }
    if (q.revisar) {
      var av = el('div', 'sbq-badge is-warn', esc(q.revisar));
      av.style.cssText = 'white-space:normal;display:block;margin-bottom:10px';
      box.appendChild(av);
    }

    box.appendChild(campo('Tipo', selectCampo(q.type, Model.ALL_TYPES.map(function (t) {
      return { value: t, text: Model.TYPE_LABELS[t] || t };
    }), function (v) {
      cambio(function () { convertirTipo(q, v); }, true);
    })));

    box.appendChild(campo('Identificador', inputTexto(q.id, function (v) {
      if (!v) return;
      cambio(function () {
        var anterior = q.id;
        q.id = v;
        renombrarReferencias(anterior, v);
      }, true);
    }, 'csat', true), 'Es el nombre de la columna en BigQuery.'));

    if (q.type === 'html') {
      box.appendChild(campo('Contenido HTML',
        campoTexto(q, 'html', { largo: true, rows: 4, mono: true })));
    } else {
      box.appendChild(campo('Enunciado', campoTexto(q, 'title', { largo: true, rows: 2 }),
        'Admite <code>{pregunta}</code> para insertar respuestas previas.'));
      box.appendChild(campo('Texto de apoyo', campoTexto(q, 'description')));
    }

    if (Model.DISPLAY_TYPES.indexOf(q.type) < 0 && q.type !== 'expression') {
      box.appendChild(campo('Rol analítico', selectCampo(q.role || '', [
        { value: '', text: '— sin rol —' },
        { value: 'score', text: 'Indicador (CSAT / NPS / CES)' },
        { value: 'driver', text: 'Palanca / driver' },
        { value: 'root_cause', text: 'Causa raíz' },
        { value: 'verbatim', text: 'Comentario abierto' },
        { value: 'context', text: 'Contexto (touchpoint, sector)' },
        { value: 'profile', text: 'Perfil (género, edad)' },
        { value: 'screener', text: 'Filtro de perfil' }
      ], function (v) { cambio(function () { if (v) q.role = v; else delete q.role; }); }),
        'Define en qué columna de BigQuery aterriza la respuesta.'));

      box.appendChild(casilla('Obligatoria', q.required, function (v) {
        cambio(function () { q.required = v; }, true);
      }));
    }

    box.appendChild(campo('Mostrar solo si', condicion(q, 'visibleIf')));

    propsPorTipo(q, box);
    propsValidacion(q, box);

    // ------------------------------------------------------------ acciones
    var acciones = el('div', 'sbq-row');
    acciones.style.marginTop = '16px';
    var arriba = el('button', 'sbq-btn sbq-btn-sm', '↑');
    arriba.title = 'Subir';
    arriba.onclick = function () { moverPregunta(-1); };
    var abajo = el('button', 'sbq-btn sbq-btn-sm', '↓');
    abajo.title = 'Bajar';
    abajo.onclick = function () { moverPregunta(1); };
    var dup = el('button', 'sbq-btn sbq-btn-sm', 'Duplicar');
    dup.onclick = function () {
      cambio(function () {
        var cont = contenedorDe(sel);
        var i = sel.ruta[sel.ruta.length - 1];
        var copia = util.clone(q);
        copia.id = q.id + '_copia';
        cont.elements.splice(i + 1, 0, copia);
        sel = { tipo: 'question', pageIndex: sel.pageIndex,
                ruta: sel.ruta.slice(0, -1).concat([i + 1]) };
      }, true);
    };
    var borrar = el('button', 'sbq-btn sbq-btn-sm sbq-btn-danger', 'Eliminar');
    borrar.onclick = function () {
      if (!global.confirm('¿Eliminar «' + (textoPlano(q.title) || q.id) + '»?')) return;
      cambio(function () {
        var cont = contenedorDe(sel);
        cont.elements.splice(sel.ruta[sel.ruta.length - 1], 1);
        sel = { tipo: 'page', pageIndex: sel.pageIndex };
      }, true);
    };
    [arriba, abajo, dup, borrar].forEach(function (b) { acciones.appendChild(b); });
    box.appendChild(acciones);
  }

  /** Al cambiar de tipo, arma lo mínimo que el nuevo necesita. */
  function convertirTipo(q, nuevo) {
    q.type = nuevo;
    if (Model.CHOICE_TYPES.indexOf(nuevo) >= 0 && !q.choices) {
      q.choices = [{ value: 'Opción 1', text: 'Opción 1' }, { value: 'Opción 2', text: 'Opción 2' }];
    }
    if (nuevo === 'rating' && q.rateMax === undefined) { q.rateMin = 1; q.rateMax = 5; }
    if (nuevo === 'matrix') {
      if (!Array.isArray(q.rows)) q.rows = [{ value: 'fila1', text: 'Primer aspecto' }];
      if (!q.columns) q.columns = [
        { value: 1, text: 'Malo' }, { value: 2, text: 'Regular' }, { value: 3, text: 'Bueno' }
      ];
    }
    if (nuevo === 'multipletext' && !q.items) {
      q.items = [{ name: 'campo1', title: 'Primer campo' }];
    }
    if (nuevo === 'panel' && !q.elements) q.elements = [];
    if (nuevo === 'comment' && Array.isArray(q.rows)) delete q.rows;
  }

  // -------------------------------------------------- propiedades por tipo

  function propsPorTipo(q, box) {
    if (q.type === 'rating') {
      var fila = el('div', 'sbq-field-row');
      fila.appendChild(campo('Mínimo', numero(q, 'rateMin')));
      fila.appendChild(campo('Máximo', numero(q, 'rateMax')));
      box.appendChild(fila);

      var fila2 = el('div', 'sbq-field-row');
      fila2.appendChild(campo('Etiqueta izquierda', campoTexto(q, 'minLabel')));
      fila2.appendChild(campo('Etiqueta derecha', campoTexto(q, 'maxLabel')));
      box.appendChild(fila2);

      box.appendChild(campo('Presentación', selectCampo(q.displayMode || 'numbers', [
        { value: 'numbers', text: 'Números' },
        { value: 'emoji', text: 'Caritas (solo escalas 1-5)' }
      ], function (v) { cambio(function () { q.displayMode = v; }); })));

      box.appendChild(casilla('Colores de NPS (rojo / ámbar / verde)', q.colorScale === 'nps',
        function (v) { cambio(function () { if (v) q.colorScale = 'nps'; else delete q.colorScale; }); }));
    }

    if (Model.CHOICE_TYPES.indexOf(q.type) >= 0) {
      box.appendChild(editorLista(q, 'choices', {
        titulo: 'Opciones',
        extra: q.type === 'imagepicker' ? 'emoji' : null
      }));
      box.appendChild(casilla('Orden aleatorio', q.randomize,
        function (v) { cambio(function () { q.randomize = v; }, true); }));

      if (q.type !== 'ranking') {
        box.appendChild(casilla('Incluir opción "Otro" con texto libre', q.hasOther,
          function (v) { cambio(function () { q.hasOther = v; }, true); }));
        if (q.hasOther) box.appendChild(campo('Texto de "Otro"', campoTexto(q, 'otherText')));
      }
      if (q.type === 'imagepicker') {
        box.appendChild(casilla('Permitir varias', q.multiSelect,
          function (v) { cambio(function () { q.multiSelect = v; }); }));
        box.appendChild(casilla('Ocultar las etiquetas', q.hideLabels,
          function (v) { cambio(function () { q.hideLabels = v; }); }));
      }
    }

    if (q.type === 'matrix') {
      box.appendChild(editorLista(q, 'rows', { titulo: 'Filas (lo que se evalúa)' }));
      box.appendChild(editorLista(q, 'columns', { titulo: 'Columnas (la escala)' }));
      box.appendChild(casilla('Exigir todas las filas', q.eachRowRequired,
        function (v) { cambio(function () { q.eachRowRequired = v; }, true); }));
    }

    if (q.type === 'multipletext') {
      box.appendChild(editorItems(q));
      box.appendChild(casilla('Exigir todos los campos', q.allItemsRequired,
        function (v) { cambio(function () { q.allItemsRequired = v; }, true); }));
    }

    if (q.type === 'file') {
      var f3 = el('div', 'sbq-field-row');
      f3.appendChild(campo('Máx. archivos', numero(q, 'maxFiles')));
      f3.appendChild(campo('Máx. MB c/u', numero(q, 'maxSizeMB')));
      box.appendChild(f3);
      box.appendChild(campo('Tipos aceptados', inputTexto(q.accept, function (v) {
        cambio(function () { q.accept = v || 'image/*'; });
      }, 'image/*'), 'Ej.: <code>image/*</code> o <code>.pdf,.jpg</code>'));
      box.appendChild(el('div', 'sbq-help',
        'Los archivos viajan aparte de la respuesta y no llegan a BigQuery: allí solo se guarda el nombre y la cantidad.'));
    }

    if (q.type === 'signature') {
      var f4 = el('div', 'sbq-field-row');
      f4.appendChild(campo('Ancho', numero(q, 'width')));
      f4.appendChild(campo('Alto', numero(q, 'height')));
      box.appendChild(f4);
    }

    if (q.type === 'expression') {
      box.appendChild(campo('Expresión',
        areaTexto(q.expression, function (v) {
          cambio(function () { q.expression = v; });
        }, 2, true),
        'Ej.: <code>round({csat} * 20)</code>. Funciones: <code>' +
        Expr.functionNames.join('</code> <code>') + '</code>'));
      box.appendChild(casilla('Ocultar si no se puede calcular', q.hideIfEmpty,
        function (v) { cambio(function () { q.hideIfEmpty = v; }); }));
    }

    if (['text', 'comment'].indexOf(q.type) >= 0) {
      box.appendChild(campo('Texto de ejemplo', campoTexto(q, 'placeholder')));
      if (q.type === 'comment') box.appendChild(campo('Alto (líneas)', numero(q, 'rows')));
      box.appendChild(campo('Tipo de dato', selectCampo(q.inputType || 'text', [
        { value: 'text', text: 'Texto' },
        { value: 'email', text: 'Correo' },
        { value: 'tel', text: 'Teléfono' },
        { value: 'number', text: 'Número' },
        { value: 'date', text: 'Fecha' }
      ], function (v) { cambio(function () { q.inputType = v; }, true); })));
    }

    if (q.type === 'panel') {
      box.appendChild(el('div', 'sbq-help',
        'Las preguntas del grupo se agregan y ordenan en el árbol de la izquierda, ' +
        'arrastrándolas hacia adentro.'));
    }
  }

  // ------------------------------------------------------------ validación

  function propsValidacion(q, box) {
    if (Model.DISPLAY_TYPES.indexOf(q.type) >= 0 || q.type === 'expression') return;

    var det = doc.createElement('details');
    det.className = 'sbq-details';
    det.appendChild(el('summary', null, 'Validación'));
    var cuerpo = el('div');

    if (Model.MULTI_TYPES.indexOf(q.type) >= 0) {
      var f = el('div', 'sbq-field-row');
      f.appendChild(campo('Mínimo de marcas', numero(q, 'minSelect')));
      f.appendChild(campo('Máximo de marcas', numero(q, 'maxSelect')));
      cuerpo.appendChild(f);
    }

    if (['text', 'comment'].indexOf(q.type) >= 0) {
      var f2 = el('div', 'sbq-field-row');
      f2.appendChild(campo('Largo mínimo', numero(q, 'minLength')));
      f2.appendChild(campo('Largo máximo', numero(q, 'maxLength')));
      cuerpo.appendChild(f2);

      cuerpo.appendChild(campo('Patrón (expresión regular)',
        inputTexto(q.pattern, function (v) {
          cambio(function () { if (v) q.pattern = v; else delete q.pattern; });
        }, '^[0-9]{8}-[0-9kK]$', true)));
      cuerpo.appendChild(campo('Mensaje si no calza', campoTexto(q, 'patternMessage')));
    }

    if (q.inputType === 'number' || q.type === 'rating') {
      var f3 = el('div', 'sbq-field-row');
      f3.appendChild(campo('Valor mínimo', numero(q, 'min')));
      f3.appendChild(campo('Valor máximo', numero(q, 'max')));
      cuerpo.appendChild(f3);
    }

    cuerpo.appendChild(campo('Válida solo si', condicion(q, 'validIf'),
      'Se evalúa contra todas las respuestas, no solo esta.'));
    cuerpo.appendChild(campo('Mensaje si no cumple', campoTexto(q, 'validMessage')));

    det.appendChild(cuerpo);
    box.appendChild(det);
  }

  // ------------------------------------------------- editores de listas --

  /** Lista de opciones, filas o columnas, con arrastre para reordenar. */
  function editorLista(q, prop, opts) {
    opts = opts || {};
    var lista = Array.isArray(q[prop]) ? q[prop] : [];
    var wrap = el('div', 'sbq-field');
    wrap.appendChild(el('label', null, esc(opts.titulo) + ' (' + lista.length + ')'));

    var cont = el('div');
    var arrastrando = null;

    lista.forEach(function (c, i) {
      var fila = el('div', 'sbq-opt-row');
      fila.draggable = true;
      fila.appendChild(el('span', 'sbq-opt-handle', '⠿'));

      if (opts.extra === 'emoji') {
        var em = inputTexto(c.emoji, function (v) {
          cambio(function () { if (v) c.emoji = v; else delete c.emoji; });
        }, '🙂');
        em.style.cssText = 'width:52px;flex:none;text-align:center';
        fila.appendChild(em);
      }

      var base = survey.locale || 'es';
      var esObj = c.text && typeof c.text === 'object';
      var visible = esObj ? (c.text[base] || '') : (c.text || '');

      fila.appendChild(inputTexto(visible, function (v) {
        cambio(function () {
          var eranIguales = c.value === (esObj ? c.text[base] : c.text);
          if (esObj) c.text[base] = v; else c.text = v;
          // Mientras no se hayan separado a propósito, el valor guardado
          // sigue al texto visible.
          if (eranIguales) c.value = v;
        });
      }));

      var quitar = el('button', 'sbq-icon-btn is-danger', '✕');
      quitar.title = 'Quitar';
      quitar.onclick = function () {
        cambio(function () { q[prop].splice(i, 1); }, true);
      };
      fila.appendChild(quitar);

      fila.ondragstart = function () { arrastrando = i; fila.classList.add('is-dragging'); };
      fila.ondragend   = function () { fila.classList.remove('is-dragging'); };
      fila.ondragover  = function (e) { e.preventDefault(); fila.classList.add('is-over'); };
      fila.ondragleave = function () { fila.classList.remove('is-over'); };
      fila.ondrop = function (e) {
        e.preventDefault();
        fila.classList.remove('is-over');
        if (arrastrando === null || arrastrando === i) return;
        var d = arrastrando;
        arrastrando = null;
        cambio(function () {
          var mov = q[prop].splice(d, 1)[0];
          q[prop].splice(i, 0, mov);
        }, true);
      };

      cont.appendChild(fila);
    });
    wrap.appendChild(cont);

    var agregar = el('button', 'sbq-btn sbq-btn-sm', '+ Agregar');
    agregar.onclick = function () {
      cambio(function () {
        if (!Array.isArray(q[prop])) q[prop] = [];
        var n = 'Opción ' + (q[prop].length + 1);
        q[prop].push({ value: n, text: n });
      }, true);
    };
    wrap.appendChild(agregar);

    var pegar = el('button', 'sbq-btn sbq-btn-sm', 'Pegar lista');
    pegar.style.marginLeft = '6px';
    pegar.onclick = function () {
      var txt = global.prompt('Pega los valores, uno por línea:');
      if (!txt) return;
      cambio(function () {
        q[prop] = txt.split('\n').map(function (s) { return s.trim(); })
          .filter(Boolean).map(function (s) { return { value: s, text: s }; });
      }, true);
    };
    wrap.appendChild(pegar);
    return wrap;
  }

  /** Campos de una pregunta de varios textos. */
  function editorItems(q) {
    var items = q.items || [];
    var wrap = el('div', 'sbq-field');
    wrap.appendChild(el('label', null, 'Campos (' + items.length + ')'));

    items.forEach(function (it, i) {
      var fila = el('div', 'sbq-opt-row');
      var nombre = inputTexto(it.name, function (v) {
        cambio(function () { it.name = v; });
      }, 'nombre');
      nombre.style.cssText = 'flex:0 0 34%';
      nombre.title = 'Nombre interno: es la clave en los datos';
      fila.appendChild(nombre);

      var base = survey.locale || 'es';
      var esObj = it.title && typeof it.title === 'object';
      fila.appendChild(inputTexto(esObj ? (it.title[base] || '') : (it.title || ''),
        function (v) {
          cambio(function () { if (esObj) it.title[base] = v; else it.title = v; });
        }, 'Etiqueta visible'));

      var quitar = el('button', 'sbq-icon-btn is-danger', '✕');
      quitar.onclick = function () { cambio(function () { q.items.splice(i, 1); }, true); };
      fila.appendChild(quitar);
      wrap.appendChild(fila);
    });

    var agregar = el('button', 'sbq-btn sbq-btn-sm', '+ Agregar campo');
    agregar.onclick = function () {
      cambio(function () {
        q.items = q.items || [];
        var n = 'campo' + (q.items.length + 1);
        q.items.push({ name: n, title: n });
      }, true);
    };
    wrap.appendChild(agregar);
    return wrap;
  }

  // ------------------------------------------------ constructor de lógica

  /**
   * Campo de condición con dos modos: visual y texto.
   *
   * El visual solo puede representar una cadena de comparaciones unidas por
   * el mismo conector. Si la condición es más enredada, se muestra en texto y
   * se dice por qué, en vez de simplificarla y romper la regla.
   */
  function condicion(obj, prop) {
    var wrap = el('div', 'sbq-cond');
    var desc = Expr.decompose(obj[prop]);
    var modo = obj['__modo_' + prop] || (desc.ok ? 'visual' : 'texto');

    var barra = el('div', 'sbq-cond-modo');
    ['visual', 'texto'].forEach(function (m) {
      var b = el('button', m === modo ? 'is-on' : '', m === 'visual' ? 'Visual' : 'Texto');
      b.type = 'button';
      b.disabled = m === 'visual' && !desc.ok;
      b.title = (m === 'visual' && !desc.ok) ? desc.motivo : '';
      b.onclick = function () {
        obj['__modo_' + prop] = m;
        dibujarProps();
        if (tab === 'logica') dibujarLogica();
      };
      barra.appendChild(b);
    });
    wrap.appendChild(barra);

    if (modo === 'visual' && desc.ok) wrap.appendChild(visualCondicion(obj, prop, desc));
    else wrap.appendChild(textoCondicion(obj, prop, desc));

    return wrap;
  }

  function textoCondicion(obj, prop, desc) {
    var wrap = el('div');
    var input = areaTexto(obj[prop], function (v) {
      cambio(function () { if (v) obj[prop] = v; else delete obj[prop]; });
      revisar(v);
    }, 2, true);
    var msg = el('div', 'sbq-help');

    function revisar(v) {
      if (!v) { msg.textContent = ''; input.style.borderColor = ''; return; }
      var r = Expr.validate(v);
      msg.innerHTML = r.ok
        ? '<span style="color:var(--ok)">✓ expresión válida</span>'
        : '<span style="color:var(--danger)">✕ ' + esc(r.error) + '</span>';
      input.style.borderColor = r.ok ? 'var(--ok)' : 'var(--danger)';
    }
    revisar(obj[prop]);

    wrap.appendChild(input);
    wrap.appendChild(msg);
    if (desc && !desc.ok && obj[prop]) {
      wrap.appendChild(el('div', 'sbq-help', '⚠ ' + esc(desc.motivo)));
    }
    return wrap;
  }

  function visualCondicion(obj, prop, desc) {
    var wrap = el('div', 'sbq-cond-visual');
    var clausulas = desc.clausulas;
    var union = desc.union;

    function aplicar() {
      var texto = Expr.compose(union, clausulas);
      cambio(function () { if (texto) obj[prop] = texto; else delete obj[prop]; });
      dibujarProps();
      if (tab === 'logica') dibujarLogica();
    }

    if (!clausulas.length) {
      wrap.appendChild(el('div', 'sbq-help', 'Siempre visible. Agrega una condición para restringirlo.'));
    }

    clausulas.forEach(function (c, i) {
      if (i > 0) {
        var conector = selectCampo(union, [
          { value: 'and', text: 'y además' },
          { value: 'or',  text: 'o bien' }
        ], function (v) { union = v; aplicar(); });
        conector.className = 'sbq-select sbq-cond-union';
        wrap.appendChild(conector);
      }

      var fila = el('div', 'sbq-cond-fila');

      // pregunta
      var refs2 = referenciables();
      var opcionesRef = refs2.map(function (r) { return { value: r.id, text: r.etiqueta }; });
      if (!refs2.some(function (r) { return r.id === c.ref; })) {
        opcionesRef.unshift({ value: c.ref, text: c.ref + ' (no existe)' });
      }
      fila.appendChild(selectCampo(c.ref, opcionesRef, function (v) { c.ref = v; aplicar(); }));

      // operador
      var opDef = Expr.OPERADORES.filter(function (o) { return o.op === c.op; })[0] ||
                  Expr.OPERADORES[0];
      fila.appendChild(selectCampo(c.op, Expr.OPERADORES.map(function (o) {
        return { value: o.op, text: o.texto };
      }), function (v) {
        c.op = v;
        var nuevo = Expr.OPERADORES.filter(function (o) { return o.op === v; })[0];
        if (nuevo.valor === 'ninguno') c.valor = null;
        if (nuevo.valor === 'varios' && !Array.isArray(c.valor)) c.valor = c.valor == null ? [] : [c.valor];
        if (nuevo.valor !== 'varios' && Array.isArray(c.valor)) c.valor = c.valor[0];
        aplicar();
      }));

      // valor
      if (opDef.valor !== 'ninguno') {
        fila.appendChild(campoValor(c, opDef, aplicar));
      }

      var quitar = el('button', 'sbq-icon-btn is-danger', '✕');
      quitar.title = 'Quitar condición';
      quitar.onclick = function () { clausulas.splice(i, 1); aplicar(); };
      fila.appendChild(quitar);

      wrap.appendChild(fila);
    });

    var agregar = el('button', 'sbq-btn sbq-btn-sm', '+ Condición');
    agregar.onclick = function () {
      var primera = referenciables()[0];
      clausulas.push({ ref: primera ? primera.id : '', op: '=', valor: '' });
      aplicar();
    };
    wrap.appendChild(agregar);
    return wrap;
  }

  /** Campo de valor: ofrece las alternativas de la pregunta si las tiene. */
  function campoValor(c, opDef, aplicar) {
    var q = Model.findQuestion(survey, c.ref);
    var opciones = q && Array.isArray(q.choices) ? q.choices : null;

    if (opDef.valor === 'varios') {
      var actual = Array.isArray(c.valor) ? c.valor : [];
      var input = inputTexto(actual.join(', '), function (v) {
        c.valor = v.split(',').map(function (x) {
          var t = x.trim();
          return t !== '' && !isNaN(Number(t)) ? Number(t) : t;
        }).filter(function (x) { return x !== ''; });
        aplicar();
      }, '0, 1, 2');
      input.title = 'Valores separados por coma';
      return input;
    }

    if (opciones && opDef.valor !== 'numero') {
      var lista = opciones.map(function (o) {
        return { value: o.value, text: textoPlano(o.text) };
      });
      if (q.hasOther) lista.push({ value: SBQ.Runtime.OTHER, text: '(la opción Otro)' });
      if (!lista.some(function (o) { return String(o.value) === String(c.valor); })) {
        lista.unshift({ value: c.valor, text: String(c.valor) });
      }
      return selectCampo(c.valor, lista, function (v) {
        var orig = opciones.filter(function (o) { return String(o.value) === v; })[0];
        c.valor = orig ? orig.value : v;
        aplicar();
      });
    }

    if (q && q.type === 'rating') {
      var nums = [];
      for (var i = q.rateMin; i <= q.rateMax; i++) nums.push({ value: i, text: String(i) });
      return selectCampo(c.valor, nums, function (v) { c.valor = Number(v); aplicar(); });
    }

    return inputTexto(c.valor, function (v) {
      c.valor = v !== '' && !isNaN(Number(v)) ? Number(v) : v;
      aplicar();
    });
  }

  /** Preguntas y variables que se pueden usar en una condición. */
  function referenciables() {
    var out = [];
    Object.keys(survey.variables || {}).forEach(function (k) {
      out.push({ id: k, etiqueta: k + ' (variable)' });
    });
    (survey.computed || []).forEach(function (c) {
      out.push({ id: c.id, etiqueta: c.id + ' (derivado)' });
    });
    Model.eachQuestion(survey, function (q) {
      if (Model.DISPLAY_TYPES.indexOf(q.type) >= 0) return;
      var t = textoPlano(q.title);
      out.push({ id: q.id, etiqueta: q.id + (t ? ' · ' + t.slice(0, 42) : '') });

      // Claves que el runtime crea junto a cada pregunta y que las condiciones
      // usan de verdad. Sin esto el constructor las marcaba como inexistentes.
      out.push({ id: q.id + '_fijado', etiqueta: q.id + '_fijado · vino precargado (QR)' });
      if (q.hasOther) {
        out.push({ id: q.id + '_otro', etiqueta: q.id + '_otro · texto de la opción Otro' });
      }
    });
    return out;
  }

  // =============================================================== LÓGICA ==

  /** Todas las reglas de la encuesta en un solo lugar. */
  function dibujarLogica() {
    if (!refs.logica) return;
    refs.logica.innerHTML = '';

    var reglas = [];
    survey.pages.forEach(function (page, pi) {
      ['visibleIf', 'disqualifyIf', 'completeIf'].forEach(function (prop) {
        if (page[prop]) reglas.push({ obj: page, prop: prop, donde: 'Página · ' + (textoPlano(page.title) || page.id) });
      });
    });
    Model.eachQuestion(survey, function (q, page) {
      ['visibleIf', 'enableIf', 'requiredIf', 'validIf'].forEach(function (prop) {
        if (q[prop]) reglas.push({ obj: q, prop: prop, donde: q.id + ' · ' + (textoPlano(q.title) || '') });
      });
    });

    var ETIQUETA = {
      visibleIf: 'se muestra si', enableIf: 'se puede responder si',
      requiredIf: 'es obligatoria si', validIf: 'es válida si',
      disqualifyIf: 'termina fuera de perfil si', completeIf: 'completa la encuesta si'
    };

    refs.logica.appendChild(el('p', 'sbq-muted',
      reglas.length + ' regla(s) de visibilidad y validación. Se editan igual que en el diseñador.'));

    if (!reglas.length) {
      refs.logica.appendChild(el('div', 'sbq-empty',
        'Sin reglas todavía. Se agregan desde el campo «Mostrar solo si» de cada pregunta.'));
    }

    reglas.forEach(function (r) {
      var caja = el('div', 'sbq-regla');
      var cab = el('div', 'sbq-regla-cab');
      cab.appendChild(el('span', 'sbq-regla-donde', esc(r.donde)));
      cab.appendChild(el('span', 'sbq-badge', esc(ETIQUETA[r.prop] || r.prop)));
      caja.appendChild(cab);
      caja.appendChild(condicion(r.obj, r.prop));
      refs.logica.appendChild(caja);
    });

    // ------------------------------------------------------ disparadores
    refs.logica.appendChild(el('h3', null, 'Disparadores'));
    refs.logica.appendChild(el('p', 'sbq-muted',
      'Se ejecutan al avanzar de página: pueden terminar la encuesta, saltar a otra página o asignar un valor.'));

    (survey.triggers || []).forEach(function (t, i) {
      var caja = el('div', 'sbq-regla');
      var cab = el('div', 'sbq-regla-cab');
      cab.appendChild(el('span', 'sbq-regla-donde', 'Disparador ' + (i + 1)));
      var borrar = el('button', 'sbq-icon-btn is-danger', '✕');
      borrar.onclick = function () {
        cambio(function () { survey.triggers.splice(i, 1); });
        dibujarLogica();
      };
      cab.appendChild(el('span', 'sbq-spacer'));
      cab.appendChild(borrar);
      caja.appendChild(cab);

      caja.appendChild(campo('Cuando', condicion(t, 'runIf')));

      var accion = t.complete ? 'complete' : (t.skipTo ? 'skipTo' : (t.setValue ? 'setValue' : 'nada'));
      caja.appendChild(campo('Entonces', selectCampo(accion, [
        { value: 'nada', text: '— sin acción —' },
        { value: 'complete', text: 'Terminar la encuesta' },
        { value: 'skipTo', text: 'Saltar a una página' },
        { value: 'setValue', text: 'Asignar un valor' }
      ], function (v) {
        cambio(function () {
          delete t.complete; delete t.skipTo; delete t.setValue;
          if (v === 'complete') t.complete = true;
          if (v === 'skipTo') t.skipTo = survey.pages[0] && survey.pages[0].id;
          if (v === 'setValue') t.setValue = { id: 'marca', value: 'sí' };
        });
        dibujarLogica();
      })));

      if (t.skipTo !== undefined) {
        caja.appendChild(campo('Página destino', selectCampo(t.skipTo,
          survey.pages.map(function (p) {
            return { value: p.id, text: (textoPlano(p.title) || p.id) };
          }), function (v) { cambio(function () { t.skipTo = v; }); })));
      }
      if (t.setValue) {
        var f = el('div', 'sbq-field-row');
        f.appendChild(campo('Campo', inputTexto(t.setValue.id, function (v) {
          cambio(function () { t.setValue.id = v; });
        }, 'segmento', true)));
        f.appendChild(campo('Valor', inputTexto(t.setValue.value, function (v) {
          cambio(function () { t.setValue.value = v; });
        })));
        caja.appendChild(f);
      }
      refs.logica.appendChild(caja);
    });

    var nuevo = el('button', 'sbq-btn sbq-btn-sm', '+ Disparador');
    nuevo.onclick = function () {
      cambio(function () {
        survey.triggers = survey.triggers || [];
        survey.triggers.push({ runIf: '', complete: false });
      });
      dibujarLogica();
    };
    refs.logica.appendChild(nuevo);
  }

  // ========================================================= TRADUCCIONES ==

  /** Rutas de todos los textos traducibles de la encuesta. */
  function textosTraducibles() {
    var out = [];
    var base = survey.locale || 'es';

    function add(obj, prop, donde, etiqueta) {
      if (obj[prop] === undefined || obj[prop] === null) return;
      out.push({ obj: obj, prop: prop, donde: donde, etiqueta: etiqueta });
    }

    add(survey, 'title', 'Encuesta', 'Título');
    add(survey, 'description', 'Encuesta', 'Descripción');
    if (survey.settings.thankYou) {
      add(survey.settings.thankYou, 'title', 'Cierre', 'Título de agradecimiento');
      add(survey.settings.thankYou, 'text', 'Cierre', 'Texto de agradecimiento');
    }
    if (survey.settings.disqualified) {
      add(survey.settings.disqualified, 'title', 'Cierre', 'Título fuera de perfil');
      add(survey.settings.disqualified, 'text', 'Cierre', 'Texto fuera de perfil');
    }

    survey.pages.forEach(function (p) {
      add(p, 'title', 'Página ' + p.id, 'Título');
      add(p, 'description', 'Página ' + p.id, 'Descripción');
    });

    Model.eachQuestion(survey, function (q) {
      var donde = q.id;
      add(q, 'title', donde, 'Enunciado');
      add(q, 'description', donde, 'Apoyo');
      add(q, 'html', donde, 'Contenido');
      add(q, 'placeholder', donde, 'Ejemplo');
      add(q, 'minLabel', donde, 'Etiqueta izq.');
      add(q, 'maxLabel', donde, 'Etiqueta der.');
      add(q, 'otherText', donde, 'Texto de "Otro"');
      add(q, 'patternMessage', donde, 'Mensaje de patrón');
      ['choices', 'rows', 'columns'].forEach(function (lista) {
        if (!Array.isArray(q[lista])) return;
        q[lista].forEach(function (c, i) {
          add(c, 'text', donde, lista + ' ' + (i + 1));
        });
      });
      if (Array.isArray(q.items)) {
        q.items.forEach(function (it, i) { add(it, 'title', donde, 'campo ' + (i + 1)); });
      }
    });
    return out;
  }

  function dibujarTraducciones() {
    if (!refs.traducciones) return;
    refs.traducciones.innerHTML = '';

    var base = survey.locale || 'es';
    var idiomas = Model.locales(survey);
    if (idiomas.indexOf(base) < 0) idiomas.unshift(base);

    // ------------------------------------------------------------ acciones
    var acc = doc.getElementById('sbq-trad-acciones');
    acc.innerHTML = '';
    var agregarIdioma = el('button', 'sbq-btn sbq-btn-sm', '+ Idioma');
    agregarIdioma.onclick = function () {
      var code = (global.prompt('Código del idioma (en, pt, fr…):') || '').trim().toLowerCase();
      if (!code || idiomas.indexOf(code) >= 0) return;
      cambio(function () {
        // Crear la clave vacía en cada texto: así aparece la columna y se puede
        // ir completando sin tocar el JSON.
        textosTraducibles().forEach(function (t) {
          var v = t.obj[t.prop];
          if (typeof v !== 'object') t.obj[t.prop] = defineBase(v, base);
          if (t.obj[t.prop][code] === undefined) t.obj[t.prop][code] = '';
        });
      });
      dibujarTraducciones();
      toast('Idioma ' + code + ' agregado');
    };
    acc.appendChild(agregarIdioma);

    idiomas.filter(function (l) { return l !== base; }).forEach(function (l) {
      var quitar = el('button', 'sbq-btn sbq-btn-sm sbq-btn-danger', 'Quitar ' + l);
      quitar.onclick = function () {
        if (!global.confirm('¿Eliminar todas las traducciones a ' + l + '?')) return;
        cambio(function () {
          textosTraducibles().forEach(function (t) {
            var v = t.obj[t.prop];
            if (v && typeof v === 'object') {
              delete v[l];
              var claves = Object.keys(v);
              if (claves.length === 1) t.obj[t.prop] = v[claves[0]];
            }
          });
        });
        dibujarTraducciones();
      };
      acc.appendChild(quitar);
    });

    // -------------------------------------------------------------- tabla
    var textos = textosTraducibles();
    var pendientes = 0;

    var wrap = el('div', 'sbq-tbl-wrap');
    var tabla = el('table', 'sbq-trad');
    var thead = doc.createElement('thead');
    var trh = doc.createElement('tr');
    trh.appendChild(el('th', null, 'Dónde'));
    idiomas.forEach(function (l) { trh.appendChild(el('th', null, esc(l))); });
    thead.appendChild(trh);
    tabla.appendChild(thead);

    var tbody = doc.createElement('tbody');
    textos.forEach(function (t) {
      var tr = doc.createElement('tr');
      var td0 = el('td', 'sbq-trad-donde');
      td0.appendChild(el('span', 'sbq-trad-id', esc(t.donde)));
      td0.appendChild(el('span', 'sbq-trad-campo', esc(t.etiqueta)));
      tr.appendChild(td0);

      idiomas.forEach(function (l) {
        var td = doc.createElement('td');
        var v = t.obj[t.prop];
        var texto = (v && typeof v === 'object') ? (v[l] || '') : (l === base ? v : '');
        var falta = l !== base && !texto;
        if (falta) { pendientes++; td.className = 'is-pendiente'; }

        var ta = doc.createElement('textarea');
        ta.className = 'sbq-trad-input';
        ta.rows = 1;
        ta.value = texto;
        ta.placeholder = falta ? 'sin traducir' : '';
        ta.oninput = function () {
          var actual = t.obj[t.prop];
          if (typeof actual !== 'object') t.obj[t.prop] = defineBase(actual, base);
          if (ta.value === '') delete t.obj[t.prop][l];
          else t.obj[t.prop][l] = ta.value;
          if (!Object.keys(t.obj[t.prop]).length) delete t.obj[t.prop];
          td.classList.toggle('is-pendiente', l !== base && !ta.value);
          marcar();
          dibujarEstado();
        };
        td.appendChild(ta);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    tabla.appendChild(tbody);
    wrap.appendChild(tabla);

    var resumen = el('div', 'sbq-row');
    resumen.style.marginBottom = '12px';
    resumen.appendChild(el('span', 'sbq-badge', textos.length + ' textos'));
    resumen.appendChild(el('span', 'sbq-badge', idiomas.length + ' idiomas'));
    resumen.appendChild(el('span', pendientes ? 'sbq-badge is-warn' : 'sbq-badge is-ok',
      pendientes ? pendientes + ' sin traducir' : 'todo traducido'));
    refs.traducciones.appendChild(resumen);
    refs.traducciones.appendChild(wrap);
  }

  /** Convierte un texto plano en objeto multi-idioma. */
  function defineBase(valor, base) {
    var o = {};
    if (valor !== undefined && valor !== null && valor !== '') o[base] = valor;
    return o;
  }

  // ================================================================= TEMA ==

  function dibujarTema() {
    if (!refs.tema) return;
    refs.tema.innerHTML = '';
    survey.theme = survey.theme || {};

    var presets = el('div', 'sbq-field');
    presets.appendChild(el('label', null, 'Combinaciones'));
    var grid = el('div', 'sbq-presets');
    Object.keys(SBQ.theme.PRESETS).forEach(function (nombre) {
      var p = SBQ.theme.PRESETS[nombre];
      var b = el('button', 'sbq-preset');
      b.type = 'button';
      b.title = nombre;
      b.appendChild(el('span', 'sbq-preset-dot', ''));
      b.querySelector('.sbq-preset-dot').style.background = p.accent;
      b.appendChild(el('span', null, esc(nombre)));
      b.onclick = function () {
        cambio(function () { survey.theme = util.clone(p); });
        dibujarTema();
      };
      grid.appendChild(b);
    });
    presets.appendChild(grid);
    refs.tema.appendChild(presets);

    SBQ.theme.CAMPOS.forEach(function (c) {
      var control;
      if (c.tipo === 'color') {
        var fila = el('div', 'sbq-color-row');
        var picker = doc.createElement('input');
        picker.type = 'color';
        picker.className = 'sbq-color';
        picker.value = /^#[0-9a-f]{6}$/i.test(survey.theme[c.id] || '')
          ? survey.theme[c.id] : (c.def || '#000000');
        var texto = inputTexto(survey.theme[c.id], function (v) {
          cambio(function () { if (v) survey.theme[c.id] = v; else delete survey.theme[c.id]; });
          aplicarPreviewTema();
        }, c.def || 'por defecto', true);
        picker.oninput = function () {
          cambio(function () { survey.theme[c.id] = picker.value; });
          texto.value = picker.value;
          aplicarPreviewTema();
        };
        fila.appendChild(picker);
        fila.appendChild(texto);
        control = fila;
      } else {
        control = inputTexto(survey.theme[c.id], function (v) {
          cambio(function () { if (v) survey.theme[c.id] = v; else delete survey.theme[c.id]; });
          aplicarPreviewTema();
        }, c.def || 'por defecto', c.tipo === 'texto');
      }
      refs.tema.appendChild(campo(c.etiqueta, control));
    });

    var limpiar = el('button', 'sbq-btn sbq-btn-sm sbq-btn-danger', 'Volver al tema por defecto');
    limpiar.onclick = function () {
      cambio(function () { delete survey.theme; });
      dibujarTema();
    };
    refs.tema.appendChild(limpiar);
    refs.tema.appendChild(el('div', 'sbq-help',
      'Los campos vacíos usan el tema base, que se adapta solo al modo claro y oscuro del teléfono.'));

    aplicarPreviewTema();
  }

  /** Vista previa del tema: la primera página, con las variables aplicadas. */
  function aplicarPreviewTema() {
    var cont = doc.getElementById('sbq-tema-preview');
    if (!cont) return;
    cont.innerHTML = '';

    var marco = el('div', 'sbq-preview-frame');
    SBQ.theme.apply(survey.theme, marco);

    var rt = new SBQ.Runtime(survey);
    var pagina = rt.visiblePages()[0];
    if (pagina) marco.appendChild(SBQ.render.page(pagina, rt, function () {}, { showFlags: false }));

    var botones = el('div', 'sbq-row');
    botones.style.marginTop = '14px';
    botones.appendChild(el('button', 'sbq-btn', 'Atrás'));
    var seguir = el('button', 'sbq-btn sbq-btn-primary', 'Continuar');
    seguir.style.flex = '1';
    botones.appendChild(seguir);
    marco.appendChild(botones);

    cont.appendChild(marco);
  }

  // ================================================================= JSON ==

  function dibujarJSON() {
    if (!refs.json) return;
    refs.json.innerHTML = '';

    var ta = doc.createElement('textarea');
    ta.className = 'sbq-textarea sbq-code sbq-json';
    ta.rows = 30;
    ta.spellcheck = false;
    ta.value = JSON.stringify(limpiarInternos(survey), null, 2);
    ta.id = 'sbq-json-area';

    var estado = doc.getElementById('sbq-json-estado');
    function revisar() {
      try {
        JSON.parse(ta.value);
        estado.innerHTML = '<span class="sbq-badge is-ok">JSON válido</span>';
        ta.style.borderColor = '';
      } catch (e) {
        estado.innerHTML = '<span class="sbq-badge is-warn">' + esc(e.message.slice(0, 60)) + '</span>';
        ta.style.borderColor = 'var(--danger)';
      }
    }
    ta.oninput = revisar;
    revisar();

    refs.json.appendChild(el('p', 'sbq-muted',
      'La definición completa. Se puede pegar una encuesta entera acá; los cambios no se aplican hasta apretar el botón.'));
    refs.json.appendChild(ta);
  }

  function aplicarJSON() {
    var ta = doc.getElementById('sbq-json-area');
    if (!ta) return;
    var def;
    try { def = JSON.parse(ta.value); }
    catch (e) { global.alert('El JSON tiene un error:\n\n' + e.message); return; }

    var problemas = Model.validateSurvey(def).filter(function (p) { return p.level === 'error'; });
    if (problemas.length && !global.confirm(
        'La definición tiene ' + problemas.length + ' error(es):\n\n' +
        problemas.slice(0, 3).map(function (p) { return '• ' + p.where + ': ' + p.message; }).join('\n') +
        '\n\n¿Aplicar de todas formas?')) return;

    cambio(function () { survey = Model.normalize(def); });
    previewRt = null;
    sel = survey.pages.length ? { tipo: 'page', pageIndex: 0 } : null;
    refrescar();
    toast('Cambios aplicados. Recuerda guardar.');
  }

  /** Quita las marcas internas del editor antes de exportar o mostrar. */
  function limpiarInternos(obj) {
    var copia = util.clone(obj);
    (function recorrer(o) {
      if (!o || typeof o !== 'object') return;
      Object.keys(o).forEach(function (k) {
        if (k.indexOf('__modo_') === 0) delete o[k];
        else recorrer(o[k]);
      });
    })(copia);
    return copia;
  }

  // ======================================================= VISTA PREVIA ===

  function dibujarPreview() {
    if (!refs.preview) return;
    refs.preview.innerHTML = '';

    var pages = survey.pages;
    if (!pages.length) {
      refs.preview.appendChild(el('div', 'sbq-empty', 'Agrega una página para ver la vista previa.'));
      return;
    }
    if (previewPage >= pages.length) previewPage = pages.length - 1;

    // Conserva las respuestas entre redibujados, para poder probar la
    // ramificación sin volver a responder todo.
    var valores = previewRt ? previewRt.values : null;
    previewRt = new SBQ.Runtime(survey, {
      prefill: valores,
      locale: previewLocale || survey.locale
    });

    // selector de idioma de la vista previa
    var locCont = doc.getElementById('sbq-preview-locale');
    if (locCont) {
      locCont.innerHTML = '';
      var idiomas = previewRt.availableLocales();
      if (idiomas.length > 1) {
        var caja = el('div', 'sbq-locale');
        idiomas.forEach(function (l) {
          var b = el('button', l === previewRt.locale ? 'is-on' : '', esc(l));
          b.type = 'button';
          b.onclick = function () { previewLocale = l; dibujarPreview(); };
          caja.appendChild(b);
        });
        locCont.appendChild(caja);
      }
    }

    var barra = el('div', 'sbq-row');
    barra.style.marginBottom = '12px';
    var nav = selectCampo(String(previewPage), pages.map(function (p, i) {
      return { value: String(i), text: (i + 1) + '. ' + (textoPlano(p.title) || p.id) };
    }), function (v) { previewPage = Number(v); dibujarPreview(); });
    nav.style.flex = '1';
    barra.appendChild(nav);
    var limpiar = el('button', 'sbq-btn sbq-btn-sm', 'Reiniciar');
    limpiar.title = 'Borrar las respuestas de prueba';
    limpiar.onclick = function () { previewRt = null; dibujarPreview(); };
    barra.appendChild(limpiar);
    refs.preview.appendChild(barra);

    var page = pages[previewPage];
    var marco = el('div', 'sbq-preview-frame');
    SBQ.theme.apply(survey.theme, marco);

    if (!previewRt.isPageVisible(page)) {
      marco.appendChild(el('div', 'sbq-empty',
        'Esta página está oculta con las respuestas de prueba actuales.<br><code>' +
        esc(page.visibleIf) + '</code>'));
    } else {
      marco.appendChild(SBQ.render.page(page, previewRt, function (id, valor) {
        previewRt.setValue(id, valor);
        dibujarPreview();
      }, { showFlags: true }));
    }
    refs.preview.appendChild(marco);

    var vals = {};
    Object.keys(previewRt.values).forEach(function (k) {
      if (k in survey.variables) return;
      vals[k] = previewRt.values[k];
    });
    if (Object.keys(vals).length) {
      var det = doc.createElement('details');
      det.style.marginTop = '10px';
      det.appendChild(el('summary', 'sbq-muted', 'Respuestas de prueba'));
      det.appendChild(el('pre', 'sbq-code sbq-muted', esc(JSON.stringify(vals, null, 2))));
      refs.preview.appendChild(det);
    }
  }

  // ========================================================== VALIDACIÓN ===

  function dibujarIssues() {
    if (!refs.issues) return;
    var problemas = Model.validateSurvey(survey);
    refs.issues.innerHTML = '';

    if (!problemas.length) {
      refs.issues.appendChild(el('div', 'sbq-badge is-ok', '✓ Sin problemas'));
      return;
    }

    var ul = el('ul', 'sbq-issues');
    problemas.forEach(function (p) {
      var li = el('li', 'level-' + p.level);
      li.appendChild(el('span', null, p.level === 'error' ? '✕' : '⚠'));
      li.appendChild(el('span', null, '<strong>' + esc(p.where) + '</strong> · ' + esc(p.message)));
      if (p.questionId) {
        li.onclick = function () { irAPregunta(p.questionId); };
      }
      ul.appendChild(li);
    });
    refs.issues.appendChild(ul);
  }

  function irAPregunta(id) {
    survey.pages.forEach(function (page, pi) {
      (function buscar(elementos, prefijo) {
        (elementos || []).forEach(function (q, qi) {
          var ruta = prefijo.concat([qi]);
          if (q.id === id) {
            sel = { tipo: 'question', pageIndex: pi, ruta: ruta };
            previewPage = pi;
            if (tab !== 'disenador') irA('disenador'); else refrescar();
            return;
          }
          if (q.type === 'panel') buscar(q.elements, ruta);
        });
      })(page.elements, []);
    });
  }

  // ========================================================= OPERACIONES ===

  function moverPagina(i, delta) {
    var j = i + delta;
    if (j < 0 || j >= survey.pages.length) return;
    cambio(function () {
      var p = survey.pages.splice(i, 1)[0];
      survey.pages.splice(j, 0, p);
      sel = { tipo: 'page', pageIndex: j };
    }, true);
  }

  function moverPregunta(delta) {
    var cont = contenedorDe(sel);
    var i = sel.ruta[sel.ruta.length - 1];
    var j = i + delta;
    if (!cont || j < 0 || j >= cont.elements.length) return;
    cambio(function () {
      var q = cont.elements.splice(i, 1)[0];
      cont.elements.splice(j, 0, q);
      sel = { tipo: 'question', pageIndex: sel.pageIndex,
              ruta: sel.ruta.slice(0, -1).concat([j]) };
    }, true);
  }

  function agregarPagina() {
    cambio(function () {
      var n = survey.pages.length + 1;
      survey.pages.push({ id: 'pagina' + n, title: 'Página ' + n, elements: [] });
      sel = { tipo: 'page', pageIndex: survey.pages.length - 1 };
    }, true);
  }

  /**
   * Agrega una pregunta del tipo indicado. Sin destino, va después de lo
   * seleccionado; con destino (soltada en el árbol), va en esa posición.
   */
  function agregarPregunta(tipo, destino, alFinal) {
    if (!survey.pages.length) agregarPagina();

    cambio(function () {
      var q = Model.normalizeQuestion(plantilla(tipo), survey);
      var cont, idx;

      if (destino) {
        cont = contenedorDe(destino);
        idx = alFinal ? cont.elements.length : destino.ruta[destino.ruta.length - 1];
      } else if (sel && sel.tipo === 'question') {
        var actual = seleccionada();
        // Soltar sobre un grupo lo mete dentro; sobre otra pregunta, al lado.
        if (actual && actual.type === 'panel') {
          cont = actual;
          idx = (cont.elements || []).length;
        } else {
          cont = contenedorDe(sel);
          idx = sel.ruta[sel.ruta.length - 1] + 1;
        }
      } else {
        cont = survey.pages[sel ? sel.pageIndex : 0];
        idx = (cont.elements || []).length;
      }

      cont.elements = cont.elements || [];
      cont.elements.splice(idx, 0, q);

      var pi = destino ? destino.pageIndex : (sel ? sel.pageIndex : 0);
      var prefijo = destino ? destino.ruta.slice(0, -1)
        : (sel && sel.tipo === 'question' && cont !== seleccionada()
            ? sel.ruta.slice(0, -1) : (sel && sel.tipo === 'question' ? sel.ruta : []));
      sel = { tipo: 'question', pageIndex: pi, ruta: prefijo.concat([idx]) };
      previewPage = pi;
    }, true);
  }

  /** Punto de partida razonable para cada tipo. */
  function plantilla(tipo) {
    var base = { id: util.uid('preg'), type: tipo, title: 'Nueva pregunta' };
    var dosOpciones = [{ value: 'Opción 1', text: 'Opción 1' }, { value: 'Opción 2', text: 'Opción 2' }];

    switch (tipo) {
      case 'rating':
        return { id: util.uid('preg'), type: 'rating', title: '¿Qué tan satisfecho quedaste?',
                 rateMin: 1, rateMax: 5, displayMode: 'emoji',
                 minLabel: 'Muy insatisfecho', maxLabel: 'Muy satisfecho' };
      case 'radio': case 'checkbox': case 'dropdown': case 'tagbox':
        return { id: util.uid('preg'), type: tipo, title: 'Nueva pregunta', choices: dosOpciones };
      case 'ranking':
        return { id: util.uid('preg'), type: 'ranking', title: 'Ordena según tu preferencia',
                 choices: dosOpciones };
      case 'imagepicker':
        return { id: util.uid('preg'), type: 'imagepicker', title: 'Elige una',
                 choices: [{ value: 'a', text: 'Opción 1', emoji: '🙂' },
                           { value: 'b', text: 'Opción 2', emoji: '😐' }] };
      case 'matrix':
        return { id: util.uid('preg'), type: 'matrix', title: 'Evalúa cada aspecto',
                 rows: [{ value: 'aspecto1', text: 'Primer aspecto' },
                        { value: 'aspecto2', text: 'Segundo aspecto' }],
                 columns: [{ value: 1, text: 'Malo' }, { value: 2, text: 'Regular' },
                           { value: 3, text: 'Bueno' }],
                 eachRowRequired: true };
      case 'multipletext':
        return { id: util.uid('preg'), type: 'multipletext', title: 'Tus datos',
                 items: [{ name: 'nombre', title: 'Nombre' }, { name: 'email', title: 'Correo' }] };
      case 'comment':
        return { id: util.uid('preg'), type: 'comment', title: 'Cuéntanos más',
                 rows: 3, maxLength: 500 };
      case 'file':
        return { id: util.uid('preg'), type: 'file', title: '¿Tienes una foto?',
                 maxFiles: 2, maxSizeMB: 5 };
      case 'signature':
        return { id: util.uid('preg'), type: 'signature', title: 'Firma', height: 160 };
      case 'panel':
        return { id: util.uid('grupo'), type: 'panel', title: 'Nuevo grupo', elements: [] };
      case 'expression':
        return { id: util.uid('calc'), type: 'expression', title: 'Valor calculado',
                 expression: '', hideIfEmpty: true };
      case 'html':
        return { id: util.uid('texto'), type: 'html', html: '<p>Texto informativo.</p>' };
      default:
        return base;
    }
  }

  /** Al renombrar una pregunta, actualiza condiciones, derivados y disparadores. */
  function renombrarReferencias(anterior, nuevo) {
    if (!anterior || anterior === nuevo) return;
    var re = new RegExp('\\{' + anterior.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\.|\\})', 'g');

    function arreglar(obj) {
      ['visibleIf', 'enableIf', 'requiredIf', 'validIf', 'disqualifyIf', 'completeIf', 'runIf',
       'expression'].forEach(function (p) {
        if (typeof obj[p] === 'string') obj[p] = obj[p].replace(re, '{' + nuevo + '$1');
      });
      if (typeof obj.title === 'string') obj.title = obj.title.replace(re, '{' + nuevo + '$1');
      if (obj.title && typeof obj.title === 'object') {
        Object.keys(obj.title).forEach(function (l) {
          obj.title[l] = String(obj.title[l]).replace(re, '{' + nuevo + '$1');
        });
      }
    }

    survey.pages.forEach(function (page) {
      arreglar(page);
      Model.flatten(page.elements).forEach(arreglar);
    });
    (survey.triggers || []).forEach(arreglar);
    (survey.computed || []).forEach(function (c) {
      ['coalesce', 'join'].forEach(function (k) {
        if (Array.isArray(c[k])) {
          c[k] = c[k].map(function (id) { return id === anterior ? nuevo : id; });
        }
      });
    });
  }

  // ================================================================== IO ===

  function guardar() {
    var limpio = limpiarInternos(survey);
    var errores = Model.validateSurvey(limpio).filter(function (p) { return p.level === 'error'; });
    if (errores.length && !global.confirm(
        'La encuesta tiene ' + errores.length + ' error(es).\n\n' +
        errores.slice(0, 3).map(function (e) { return '• ' + e.where + ': ' + e.message; }).join('\n') +
        '\n\n¿Guardar de todas formas?')) return;

    if (SBQ.storage.saveDraft(limpio)) {
      toast('Guardado. El respondedor ya usa esta versión.');
      dibujarEstado();
    } else {
      toast('No se pudo guardar: almacenamiento no disponible.');
    }
  }

  /**
   * Publica la encuesta para que la vea quien responde.
   *
   * Guardar deja el cambio en este navegador; publicar lo pone en la calle.
   * Se piden notas porque el historial de versiones es lo que después permite
   * entender por qué una respuesta vieja tiene preguntas que ya no existen.
   */
  function publicar() {
    var limpio = limpiarInternos(survey);
    var errores = Model.validateSurvey(limpio).filter(function (e) { return e.level === 'error'; });
    if (errores.length) {
      // Guardar con errores es asunto de quien edita; publicarlos no, porque
      // los ve la gente que responde.
      global.alert('No se puede publicar con ' + errores.length + ' error(es) sin resolver:\n\n' +
        errores.slice(0, 5).map(function (e) { return '• ' + e.where + ': ' + e.message; }).join('\n') +
        '\n\nRevísalos y vuelve a intentar.');
      return;
    }

    var notas = global.prompt('¿Qué cambiaste? (queda en el historial de versiones)', '');
    if (notas === null) return;

    var clave = sesionClave();
    var btn = doc.getElementById('btn-publicar');
    var antes = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Publicando…'; }

    global.fetch(SBQ.config.encuestasEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-SBQ-Clave': clave },
      body: JSON.stringify({ survey: limpio, notas: notas })
    }).then(function (r) {
      if (r.status === 401) { guardarClave(''); throw new Error('mala'); }
      if (!r.ok) throw new Error('http-' + r.status);
      return r.json();
    }).then(function () {
      if (btn) { btn.disabled = false; btn.textContent = antes; }
      SBQ.storage.saveDraft(limpio);   // que quede también acá, coherente
      dibujarEstado();
      toast('Publicada. Quien abra la encuesta ahora verá esta versión.');
    }).catch(function (err) {
      if (btn) { btn.disabled = false; btn.textContent = antes; }
      if (err.message === 'mala') {
        alert('La clave dejó de ser válida. Vuelve a entrar.');
        global.location.reload();
      } else {
        toast('No se pudo publicar. El cambio no se perdió; reintenta.');
      }
    });
  }

  function restaurar() {
    if (!global.confirm('Se descartan los cambios locales y vuelve la versión original de ' +
                        survey.id + '. ¿Continuar?')) return;
    SBQ.storage.discardDraft(baseId);
    cargar(baseId);
    toast('Versión original restaurada.');
  }

  function descargar(nombre, contenido, tipo) {
    var blob = new Blob([contenido], { type: tipo + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = doc.createElement('a');
    a.href = url;
    a.download = nombre;
    doc.body.appendChild(a);
    a.click();
    doc.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function exportar(formato) {
    var json = JSON.stringify(limpiarInternos(survey), null, 2);
    if (formato === 'json') {
      descargar(survey.id + '.json', json, 'application/json');
      toast('JSON descargado.');
    } else {
      var js = '/*! surveyBQ — ' + textoPlano(survey.title) + ' (exportado ' +
               new Date().toISOString().slice(0, 10) + ') */\nSBQ.registerSurvey(' + json + ');\n';
      descargar(survey.id + '.js', js, 'application/javascript');
      toast('Archivo .js descargado: reemplaza el de surveys/ y súbelo al repositorio.');
    }
  }

  function importar() {
    var input = doc.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = function () {
      var file = input.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var def = JSON.parse(reader.result);
          var problemas = Model.validateSurvey(def).filter(function (p) { return p.level === 'error'; });
          if (problemas.length && !global.confirm(
              'El archivo tiene ' + problemas.length + ' error(es). ¿Cargarlo igual?')) return;
          survey = Model.normalize(def);
          previewRt = null;
          sel = survey.pages.length ? { tipo: 'page', pageIndex: 0 } : null;
          marcar();
          refrescar();
          toast('Encuesta importada. Recuerda guardar.');
        } catch (e) {
          global.alert('No se pudo leer el archivo: ' + e.message);
        }
      };
      reader.readAsText(file);
    };
    input.click();
  }

  // ------------------------------------------------------------- arranque

  /* Acceso para depurar y para las pruebas automatizadas. */
  global.SBQ_EDITOR = {
    get survey() { return survey; },
    get seleccion() { return sel; },
    get historial() { return { largo: historial.pila.length, pos: historial.pos }; },
    irA: function (t) { irA(t); },
    irAPregunta: irAPregunta,
    refrescar: refrescar
  };

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot);
  else boot();

})(typeof window !== 'undefined' ? window : globalThis);
