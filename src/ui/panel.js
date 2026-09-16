/*!
 * surveyBQ — panel.js
 * Panel de resultados. Lee las respuestas guardadas en el navegador o un
 * archivo importado, y arma un gráfico por pregunta según su tipo.
 *
 * Criterios de los gráficos:
 *  · Una serie -> un color. El largo de la barra ya dice la magnitud; teñirla
 *    por tamaño gastaría el único canal libre en repetir lo mismo.
 *  · Los colores de estado (rojo/ámbar/verde) solo cuando el color SIGNIFICA
 *    bueno o malo, y siempre con su etiqueta al lado.
 *  · En multi-respuesta el porcentaje va sobre personas, no sobre marcas, y se
 *    dice explícitamente porque suma más de 100%.
 *  · Todo gráfico tiene su tabla de números detrás.
 */
(function (global) {
  'use strict';

  var SBQ = global.SBQ;
  var doc = global.document;
  var Model = SBQ.Model;
  var A = SBQ.analisis;
  var el = SBQ.render.el;
  var esc = SBQ.util.esc;

  var survey = null;
  var todas = [];          // respuestas de la encuesta activa
  var origen = null;       // conjunto completo (archivo o BigQuery), todas las encuestas
  var fuente = 'local';
  var modoRemoto = false;   // el panel lee de BigQuery con clave
  var filtros = [];
  var desde = '', hasta = '';
  var mostrarEscasas = false;
  var refs = {};

  var SERIES = ['var(--serie-1)', 'var(--serie-2)', 'var(--serie-3)', 'var(--serie-4)',
                'var(--serie-5)', 'var(--serie-6)', 'var(--serie-7)', 'var(--serie-8)'];
  var ESTADOS = { malo: 'var(--est-malo)', medio: 'var(--est-medio)', bueno: 'var(--est-bueno)' };

  // ------------------------------------------------------------------ inicio

  function boot() {
    refs.filtros = doc.getElementById('sbq-filtros');
    refs.kpis = doc.getElementById('sbq-kpis');
    refs.graficos = doc.getElementById('sbq-graficos');
    refs.picker = doc.getElementById('sbq-picker');
    refs.fuente = doc.getElementById('sbq-fuente');

    Object.keys(SBQ.surveys).forEach(function (id) {
      var o = doc.createElement('option');
      o.value = id;
      o.textContent = SBQ.surveys[id].title;
      refs.picker.appendChild(o);
    });

    var pedido = SBQ.util.queryParams().survey;
    refs.picker.value = Object.keys(SBQ.surveys).indexOf(pedido) >= 0
      ? pedido : Object.keys(SBQ.surveys)[0];
    refs.picker.onchange = function () {
      // En remoto cada encuesta está en otro dataset: hay que volver a pedirla,
      // no basta con filtrar lo que ya se trajo.
      if (fuente === 'bigquery') cargarDesdeBQ(sesionClave());
      else cargarEncuesta(refs.picker.value);
    };

    doc.getElementById('btn-cargar').onclick = importar;
    doc.getElementById('btn-muestra').onclick = cargarMuestra;
    doc.getElementById('btn-exportar').onclick = exportar;
    doc.getElementById('btn-imprimir').onclick = function () { global.print(); };

    montarTooltip();

    // Con endpoint de lectura configurado, el panel muestra los datos de
    // BigQuery en vivo, detrás de una clave. Sin él, se comporta como antes:
    // respuestas locales o un archivo importado.
    var url = (SBQ.config && SBQ.config.panelEndpoint) || '';
    if (url) {
      modoRemoto = true;
      var clave = sesionClave();
      if (clave) cargarDesdeBQ(clave);
      else pantallaClave();
    } else {
      cargarEncuesta(refs.picker.value);
    }
  }

  // --------------------------------------------------------- lectura remota

  function sesionClave() {
    try { return global.sessionStorage.getItem('sbq:panel:clave') || ''; }
    catch (e) { return ''; }
  }
  function guardarClave(c) {
    try { if (c) global.sessionStorage.setItem('sbq:panel:clave', c);
          else global.sessionStorage.removeItem('sbq:panel:clave'); }
    catch (e) {}
  }

  /** Pide la clave. Se queda en la pantalla hasta que sea correcta. */
  function pantallaClave(aviso) {
    refs.filtros.style.display = 'none';
    refs.kpis.innerHTML = '';
    refs.graficos.innerHTML = '';
    refs.fuente.innerHTML = '';

    var card = el('div', 'sbq-g sbq-clave-card');
    card.appendChild(el('h2', null, 'Resultados protegidos'));
    card.appendChild(el('p', 'sbq-muted',
      'Ingresa la clave del equipo para ver los resultados del piloto.'));
    if (aviso) card.appendChild(el('p', 'sbq-clave-error', esc(aviso)));

    var form = doc.createElement('form');
    form.className = 'sbq-clave-form';
    var inp = doc.createElement('input');
    inp.type = 'password';
    inp.className = 'sbq-input';
    inp.placeholder = 'Clave';
    inp.autocomplete = 'current-password';
    var btn = el('button', 'sbq-btn sbq-btn-primary', 'Entrar');
    btn.type = 'submit';
    form.appendChild(inp);
    form.appendChild(btn);
    form.onsubmit = function (e) {
      e.preventDefault();
      if (!inp.value) return;
      btn.disabled = true;
      btn.textContent = 'Verificando…';
      cargarDesdeBQ(inp.value, function () {
        btn.disabled = false;
        btn.textContent = 'Entrar';
      }, function (intento, total) {
        // Un botón mudo veinte segundos parece colgado.
        btn.textContent = 'Reintentando… (' + intento + ' de ' + total + ')';
      });
    };
    card.appendChild(form);
    refs.graficos.appendChild(card);
    inp.focus();
  }

  /** Trae las respuestas de BigQuery con la clave. */
  /**
   * Trae las respuestas de BigQuery, reintentando los fallos pasajeros.
   *
   * El servicio escala a cero: si nadie abrió el panel en varios días, la
   * primera consulta tiene que levantar un contenedor y además leer el mapa de
   * clientes, y puede tardar bastante o cortarse. Sin reintento, eso dejaba a
   * alguien con la clave correcta frente a un "no se pudo consultar", sin más
   * pista que volver a intentarlo a mano.
   *
   * Una clave incorrecta no se reintenta: reintentar no la va a arreglar.
   */
  function cargarDesdeBQ(clave, onError, onProgreso) {
    // Se pide por encuesta: cada cliente vive en su propio dataset, así que no
    // existe una consulta que traiga "todo" —y es justamente lo que se busca.
    var id = refs.picker.value;
    var url = SBQ.config.panelEndpoint + '?survey=' + encodeURIComponent(id);
    var esperas = [0, 2000, 6000];   // tres intentos, dando tiempo al arranque

    function intentar(n) {
      return global.fetch(url, {
        method: 'GET',
        headers: { 'X-SBQ-Clave': clave }
      }).then(function (res) {
        if (res.status === 401) {
          guardarClave('');
          var e = new Error('clave-mala');
          e.definitivo = true;          // reintentar no la va a arreglar
          throw e;
        }
        if (res.status === 400) {
          // El servidor no entendió la petición. En la práctica eso significa
          // que esta pestaña lleva abierta desde antes de un cambio y corre una
          // versión anterior del panel: le pasó a alguien que lo dejó abierto
          // varios días y quedó pidiendo los datos como se pedían antes.
          // Reintentar no sirve; recargar sí.
          var v = new Error('version-vieja');
          v.definitivo = true;
          throw v;
        }
        if (!res.ok) throw new Error('http-' + res.status);
        return res.json();
      }).catch(function (err) {
        if (err.definitivo || n >= esperas.length - 1) throw err;
        if (onProgreso) onProgreso(n + 2, esperas.length);
        return new Promise(function (r) { global.setTimeout(r, esperas[n + 1]); })
          .then(function () { return intentar(n + 1); });
      });
    }

    return intentar(0).then(function (data) {
      guardarClave(clave);
      try { global.sessionStorage.removeItem('sbq:panel:recargado'); } catch (e) {}
      origen = data.respuestas || [];
      fuente = 'bigquery';
      refs.filtros.style.display = '';
      cargarEncuesta(refs.picker.value);
      toast(origen.length + ' respuestas cargadas de BigQuery.');
    }).catch(function (err) {
      if (onError) onError();
      if (err.message === 'clave-mala') { pantallaClave('Clave incorrecta.'); return; }

      if (err.message === 'version-vieja') {
        // Se recarga sola, una sola vez: si tras recargar vuelve a pasar, el
        // problema es otro y entrar en bucle solo lo escondería.
        var yaRecargo = false;
        try { yaRecargo = global.sessionStorage.getItem('sbq:panel:recargado') === '1'; }
        catch (e) {}
        if (!yaRecargo) {
          try { global.sessionStorage.setItem('sbq:panel:recargado', '1'); } catch (e) {}
          global.location.reload();
          return;
        }
        pantallaClave('Esta pestaña tiene una versión antigua del panel. ' +
                      'Ciérrala y vuelve a abrirla.');
        return;
      }

      pantallaClave('El servidor no responde. Vuelve a intentar en un minuto: ' +
                    'la primera consulta del día tarda más porque el servicio ' +
                    'arranca al recibirla.');
    });
  }

  function salirRemoto() {
    guardarClave('');
    origen = null;
    pantallaClave();
  }

  function cargarEncuesta(id) {
    survey = Model.normalize(SBQ.getSurvey(id));
    SBQ.theme.apply(survey.theme);
    if (fuente === 'local') todas = SBQ.storage.listResponses(id);
    else todas = (origen || []).filter(function (r) { return r.survey_id === id; });
    filtros = [];
    desde = hasta = '';
    dibujar();
  }

  function toast(msg) {
    var t = doc.getElementById('sbq-toast');
    t.textContent = msg;
    t.classList.add('is-on');
    clearTimeout(t._t);
    t._t = setTimeout(function () { t.classList.remove('is-on'); }, 2400);
  }

  // ------------------------------------------------------------------ datos

  function importar() {
    var input = doc.createElement('input');
    input.type = 'file';
    input.accept = '.json,.ndjson,application/json';
    input.onchange = function () {
      var f = input.files[0];
      if (!f) return;
      var lector = new FileReader();
      lector.onload = function () {
        var txt = String(lector.result).trim();
        var datos;
        try {
          datos = txt[0] === '[' ? JSON.parse(txt)
            : txt.split('\n').filter(Boolean).map(function (l) { return JSON.parse(l); });
        } catch (e) {
          global.alert('No se pudo leer el archivo:\n\n' + e.message);
          return;
        }
        if (!Array.isArray(datos) || !datos.length) {
          global.alert('El archivo no tiene respuestas.');
          return;
        }
        origen = datos;
        fuente = 'archivo:' + f.name;
        var id = datos[0].survey_id;
        if (id && SBQ.surveys[id]) refs.picker.value = id;
        cargarEncuesta(refs.picker.value);
        toast(datos.length + ' respuestas cargadas de ' + f.name);
      };
      lector.readAsText(f);
    };
    input.click();
  }

  function cargarMuestra() {
    global.fetch('datos/muestra-demo.json')
      .then(function (r) {
        if (!r.ok) throw new Error('no está el archivo de ejemplo');
        return r.json();
      })
      .then(function (datos) {
        origen = datos;
        fuente = 'ejemplo';
        refs.picker.value = 'demo-tipos';
        cargarEncuesta('demo-tipos');
        toast(datos.length + ' respuestas de ejemplo (simuladas)');
      })
      .catch(function (e) {
        global.alert('No se pudo cargar el ejemplo: ' + e.message +
                     '\n\nGeneralo con:\nnode tools/generar_muestra.js 250 > datos/muestra-demo.json');
      });
  }

  function exportar() {
    var datos = aplicarFiltros();
    if (!datos.length) { toast('No hay respuestas que exportar.'); return; }
    var csv = SBQ.bigquery.toCSV(datos);
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = doc.createElement('a');
    a.href = url;
    a.download = survey.id + '_filtrado_' + new Date().toISOString().slice(0, 10) + '.csv';
    doc.body.appendChild(a); a.click(); doc.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    toast(datos.length + ' respuestas exportadas.');
  }

  function aplicarFiltros() { return A.filtrar(todas, filtros, desde, hasta); }

  // --------------------------------------------------------------- tooltip

  var tip;
  function montarTooltip() {
    tip = doc.getElementById('tip');
    doc.addEventListener('mouseover', function (e) {
      var t = e.target.dataset && e.target.dataset.tip;
      if (!t) return;
      tip.textContent = t;
      tip.classList.add('is-on');
      mover(e);
    });
    doc.addEventListener('mousemove', function (e) {
      if (tip.classList.contains('is-on')) mover(e);
    });
    doc.addEventListener('mouseout', function () { tip.classList.remove('is-on'); });
  }
  function mover(e) {
    var r = tip.getBoundingClientRect();
    tip.style.left = Math.min(Math.max(8, e.clientX - r.width / 2),
                              global.innerWidth - r.width - 8) + 'px';
    tip.style.top = Math.max(8, e.clientY - r.height - 12) + 'px';
  }

  // --------------------------------------------------------------- formato

  function pct(x, dec) { return (x * 100).toFixed(dec === undefined ? 1 : dec) + '%'; }
  function num(x) { return new Intl.NumberFormat('es-CL').format(x); }
  function dur(s) {
    if (s == null) return '—';
    return s < 60 ? s + ' s' : Math.floor(s / 60) + ' min ' + (s % 60) + ' s';
  }
  /**
   * Texto de un enunciado para el panel.
   *
   * Los enunciados pueden llevar {referencias} que se resuelven con la
   * respuesta de cada persona. Acá se agrega sobre todas, así que no hay un
   * valor único: se reemplazan por puntos suspensivos en vez de mostrar la
   * llave cruda, que parecería un error.
   */
  function txt(v) {
    var t = Model.localized(v, survey.locale, survey.locale);
    if (typeof t !== 'string') return t;
    return t.replace(/\{[A-Za-z0-9_.]+\}/g, '…').replace(/\s{2,}/g, ' ');
  }

  /** Texto legible de un valor codificado, usando las alternativas si existen. */
  function etiqueta(q, valor) {
    if (valor === 'Otro') return 'Otro (texto libre)';
    if (q && Array.isArray(q.choices)) {
      var c = q.choices.filter(function (x) { return String(x.value) === String(valor); })[0];
      if (c) return String(txt(c.text));
    }
    return String(valor);
  }

  // ================================================================ DIBUJO ==

  function dibujar() {
    dibujarFuente();
    dibujarFiltros();

    var datos = aplicarFiltros();
    if (!todas.length) return sinDatos();

    dibujarKPIs(datos);
    dibujarGraficos(datos);
  }

  function dibujarFuente() {
    refs.fuente.innerHTML = '';
    var etq = fuente === 'local' ? 'este navegador'
      : (fuente === 'ejemplo' ? 'datos de ejemplo' : fuente.replace('archivo:', ''));
    var b = el('span', fuente === 'ejemplo' ? 'sbq-badge is-warn' : 'sbq-badge',
      todas.length + ' respuestas · ' + etq);
    refs.fuente.appendChild(b);
    if (fuente === 'ejemplo') b.title = 'Cifras simuladas. No son respuestas reales.';

    if (fuente === 'bigquery') {
      var actualizar = el('button', 'sbq-btn sbq-btn-sm', '↻ Actualizar');
      actualizar.onclick = function () { cargarDesdeBQ(sesionClave()); };
      var salir = el('button', 'sbq-btn sbq-btn-sm', 'Salir');
      salir.onclick = salirRemoto;
      refs.fuente.appendChild(actualizar);
      refs.fuente.appendChild(salir);
    }
  }

  function sinDatos() {
    refs.kpis.innerHTML = '';
    refs.graficos.innerHTML = '';
    var caja = el('div', 'sbq-g is-ancho sbq-vacio-datos');
    caja.appendChild(el('h2', null, 'Todavía no hay respuestas'));
    caja.appendChild(el('p', 'sbq-muted',
      'Responde la encuesta para ver los resultados acá, importa un archivo exportado, ' +
      'o carga los datos de ejemplo para conocer el panel.'));
    var fila = el('div', 'sbq-row');
    fila.style.justifyContent = 'center';
    fila.style.marginTop = '16px';
    var b1 = el('button', 'sbq-btn sbq-btn-primary', 'Datos de ejemplo');
    b1.onclick = cargarMuestra;
    var b2 = el('a', 'sbq-btn', 'Responder ahora');
    b2.href = 'responder.html?survey=' + encodeURIComponent(survey.id);
    fila.appendChild(b1); fila.appendChild(b2);
    caja.appendChild(fila);
    refs.graficos.appendChild(caja);
  }

  // ---------------------------------------------------------------- filtros

  function dibujarFiltros() {
    refs.filtros.innerHTML = '';
    if (!todas.length) { refs.filtros.style.display = 'none'; return; }
    refs.filtros.style.display = '';

    /* En una encuesta muy ramificada casi todas las preguntas tienen
       alternativas, pero filtrar por una que respondió el 2% no sirve de nada
       y llena la pantalla. Se ofrecen las de mayor cobertura, hasta ocho. */
    var MIN_COBERTURA = 0.1;
    var MAX_FILTROS = 8;

    var filtrables = Model.allQuestions(survey)
      .filter(function (q) {
        return Array.isArray(q.choices) && q.choices.length && q.choices.length <= 30;
      })
      .map(function (q) { return { q: q, d: A.distribucion(todas, q) }; })
      .filter(function (x) { return x.d.personas / todas.length >= MIN_COBERTURA; })
      .sort(function (a, b) { return b.d.personas - a.d.personas; })
      .slice(0, MAX_FILTROS);

    // Un filtro activo sobre una pregunta que quedó fuera igual debe verse.
    filtros.forEach(function (f) {
      if (filtrables.some(function (x) { return x.q.id === f.id; })) return;
      var q = Model.findQuestion(survey, f.id);
      if (q) filtrables.push({ q: q, d: A.distribucion(todas, q) });
    });

    filtrables.forEach(function (par) {
      var q = par.q, d = par.d;
      if (!d.items.length) return;

      var f = el('div', 'sbq-filtro');
      f.appendChild(el('label', null, esc(String(txt(q.title)).slice(0, 40))));

      var s = doc.createElement('select');
      s.className = 'sbq-select';
      var actual = filtros.filter(function (x) { return x.id === q.id; })[0];
      var todo = doc.createElement('option');
      todo.value = '';
      todo.textContent = 'Todas (' + d.personas + ')';
      s.appendChild(todo);
      d.items.forEach(function (it) {
        var o = doc.createElement('option');
        o.value = it.valor;
        o.textContent = etiqueta(q, it.valor) + ' (' + it.n + ')';
        if (actual && actual.valores[0] === it.valor) o.selected = true;
        s.appendChild(o);
      });
      s.onchange = function () {
        filtros = filtros.filter(function (x) { return x.id !== q.id; });
        if (s.value) filtros.push({ id: q.id, valores: [s.value] });
        dibujar();
      };
      f.appendChild(s);
      refs.filtros.appendChild(f);
    });

    ['Desde', 'Hasta'].forEach(function (etq, i) {
      var f = el('div', 'sbq-filtro');
      f.appendChild(el('label', null, etq));
      var inp = doc.createElement('input');
      inp.type = 'date';
      inp.className = 'sbq-input';
      inp.value = i === 0 ? desde : hasta;
      inp.onchange = function () {
        if (i === 0) desde = inp.value; else hasta = inp.value;
        dibujar();
      };
      f.appendChild(inp);
      refs.filtros.appendChild(f);
    });

    if (filtros.length || desde || hasta) {
      var limpiar = el('button', 'sbq-btn sbq-btn-sm', 'Quitar filtros');
      limpiar.onclick = function () { filtros = []; desde = hasta = ''; dibujar(); };
      refs.filtros.appendChild(limpiar);
    }
  }

  // ------------------------------------------------------------------- KPIs

  function dibujarKPIs(datos) {
    refs.kpis.innerHTML = '';
    var r = A.resumen(datos, survey);

    function kpi(label, valor, nota, destacado) {
      var k = el('div', 'sbq-kpi' + (destacado ? ' is-destacado' : ''));
      k.appendChild(el('div', 'sbq-kpi-label', esc(label)));
      k.appendChild(el('div', 'sbq-kpi-valor', esc(valor)));
      if (nota) k.appendChild(el('div', 'sbq-kpi-nota', esc(nota)));
      refs.kpis.appendChild(k);
      return k;
    }

    if (r.indicador) {
      var i = r.indicador;
      kpi(i.tipo === 'NPS' ? 'NPS' : '% CSAT',
          i.formato === 'nps' ? Math.round(i.valor) : pct(i.valor),
          'promedio ' + i.promedio.toFixed(2) + ' · n = ' + num(i.n), true);
    }
    kpi('Respuestas', num(r.total),
        r.total !== datos.length ? '' : (filtros.length || desde || hasta ? 'filtradas' : 'todas'));
    kpi('Completitud', r.tasaCompletitud == null ? '—' : pct(r.tasaCompletitud, 0),
        num(r.completas) + ' completas · ' + num(r.parciales) + ' abandonadas');
    kpi('Duración mediana', dur(r.duracionMediana), 'de las completadas');
    if (r.fuera) kpi('Fuera de perfil', num(r.fuera), 'no pasaron el filtro');
  }

  // ============================================================= GRÁFICOS ==

  function tarjeta(titulo, n, sub, ancho) {
    var g = el('div', 'sbq-g' + (ancho ? ' is-ancho' : ''));
    var cab = el('div', 'sbq-g-cab');
    cab.appendChild(el('div', 'sbq-g-tit', esc(titulo)));
    if (n !== null && n !== undefined) cab.appendChild(el('div', 'sbq-g-n', 'n = ' + num(n)));
    g.appendChild(cab);
    if (sub) g.appendChild(el('div', 'sbq-g-sub', sub));
    return g;
  }

  /** Tabla plegada con los números que hay detrás del gráfico. */
  function tabla(g, cabeceras, filas) {
    var boton = el('button', 'sbq-ver-tabla', 'Ver los números');
    var cont = el('div', 'sbq-hidden');

    var t = el('table', 'sbq-datos-tabla');
    var thead = doc.createElement('thead');
    var tr = doc.createElement('tr');
    cabeceras.forEach(function (c, i) {
      tr.appendChild(el('th', i ? 'n' : '', esc(c)));
    });
    thead.appendChild(tr);
    t.appendChild(thead);

    var tb = doc.createElement('tbody');
    filas.forEach(function (f) {
      var r = doc.createElement('tr');
      f.forEach(function (c, i) { r.appendChild(el('td', i ? 'n' : '', esc(c))); });
      tb.appendChild(r);
    });
    t.appendChild(tb);
    cont.appendChild(t);

    boton.onclick = function () {
      var oculta = cont.classList.toggle('sbq-hidden');
      boton.textContent = oculta ? 'Ver los números' : 'Ocultar los números';
    };
    g.appendChild(boton);
    g.appendChild(cont);
  }

  /**
   * Barras horizontales de una sola serie. El color no varía con el tamaño:
   * el largo ya dice la magnitud.
   */
  function barras(g, items, opts) {
    opts = opts || {};
    var max = Math.max.apply(null, items.map(function (i) { return i.n; }).concat([1]));
    var cont = el('div', 'sbq-barras');

    items.forEach(function (it) {
      var fila = el('div', 'sbq-barra-fila');
      fila.appendChild(el('div', 'sbq-barra-lbl', esc(it.etiqueta)));

      var pista = el('div', 'sbq-barra-pista');
      var val = el('div', 'sbq-barra-val');
      val.style.width = (it.n / max * 100) + '%';
      if (it.color) val.style.background = it.color;
      val.dataset.tip = it.etiqueta + ': ' + num(it.n) +
        (it.pct != null ? ' · ' + pct(it.pct) : '');
      pista.appendChild(val);
      fila.appendChild(pista);

      var numero = el('div', 'sbq-barra-num');
      numero.innerHTML = '<b>' + num(it.n) + '</b>' +
        (it.pct != null ? ' · ' + pct(it.pct, 0) : '');
      fila.appendChild(numero);
      cont.appendChild(fila);
    });
    g.appendChild(cont);
    if (opts.nota) g.appendChild(el('div', 'sbq-g-sub', opts.nota));
  }

  /** Barra apilada con leyenda. Se usa cuando el reparto es el dato. */
  function apilada(g, segmentos, total) {
    var barra = el('div', 'sbq-apilada');
    segmentos.forEach(function (s) {
      if (!s.n) return;
      var d = el('div', null, s.n / total > 0.07 ? pct(s.n / total, 0) : '');
      d.style.background = s.color;
      d.style.flex = String(s.n);
      d.dataset.tip = s.texto + ': ' + num(s.n) + ' · ' + pct(s.n / total);
      barra.appendChild(d);
    });
    g.appendChild(barra);

    var ley = el('div', 'sbq-leyenda');
    segmentos.forEach(function (s) {
      var sp = el('span', null, esc(s.texto) + ' · ' + num(s.n));
      var i = doc.createElement('i');
      i.style.background = s.color;
      sp.insertBefore(i, sp.firstChild);
      ley.appendChild(sp);
    });
    g.appendChild(ley);
  }

  function dibujarGraficos(datos) {
    refs.graficos.innerHTML = '';
    if (!datos.length) {
      var v = el('div', 'sbq-g is-ancho sbq-vacio-datos');
      v.appendChild(el('h2', null, 'Ninguna respuesta cumple los filtros'));
      v.appendChild(el('p', 'sbq-muted', 'Prueba quitando alguno.'));
      refs.graficos.appendChild(v);
      return;
    }

    graficoIndicador(datos);
    graficoSerie(datos);

    /* Con menos de este número de casos, un gráfico de porcentajes engaña más
       de lo que informa: dos respuestas se ven como un 50%. En la base real
       varias causas raíz tienen 16 casos en cinco meses. */
    var MIN_N = 15;
    var escasas = [];

    Model.allQuestions(survey).forEach(function (q) {
      if (Model.DISPLAY_TYPES.indexOf(q.type) >= 0) return;
      if (q.id === Model.preguntaIndicadora(survey)) return;

      var n = datos.filter(function (r) { return A.codigosDe(r, q.id).length; }).length;
      if (n === 0) return;
      if (n < MIN_N && !mostrarEscasas) { escasas.push({ q: q, n: n }); return; }
      graficoPregunta(q, datos);
    });

    if (escasas.length) {
      var aviso = el('div', 'sbq-g is-ancho');
      aviso.appendChild(el('div', 'sbq-g-tit',
        escasas.length + ' preguntas con menos de ' + MIN_N + ' respuestas'));
      aviso.appendChild(el('div', 'sbq-g-sub',
        'Se ocultan porque con tan pocos casos un porcentaje engaña: dos respuestas ' +
        'se ven como un 50%. Son sobre todo causas raíz, que conviene leer trimestralmente.'));

      var listado = el('div', 'sbq-nube');
      escasas.sort(function (a, b) { return b.n - a.n; }).forEach(function (x) {
        var sp = el('span', null, esc(String(txt(x.q.title) || x.q.id).slice(0, 46)) +
          ' <b>' + x.n + '</b>');
        sp.style.fontSize = '.8rem';
        listado.appendChild(sp);
      });
      aviso.appendChild(listado);

      var ver = el('button', 'sbq-ver-tabla', 'Mostrarlas igual');
      ver.onclick = function () { mostrarEscasas = true; dibujar(); };
      aviso.appendChild(ver);
      refs.graficos.appendChild(aviso);
    } else if (mostrarEscasas) {
      var volver = el('div', 'sbq-g is-ancho');
      var b = el('button', 'sbq-ver-tabla', 'Volver a ocultar las de muestra pequeña');
      b.onclick = function () { mostrarEscasas = false; dibujar(); };
      volver.appendChild(b);
      refs.graficos.appendChild(volver);
    }
  }

  /** Reparto del indicador principal. Acá el color SÍ significa bueno o malo. */
  function graficoIndicador(datos) {
    var r = A.resumen(datos, survey);
    if (!r.indicador) return;
    var i = r.indicador;
    var qScore = Model.findQuestion(survey, Model.preguntaIndicadora(survey));

    // Sin pregunta indicadora igual se dibuja: el indicador ya está calculado
    // y quedarse sin gráfico por un título es peor que un título genérico.
    var rotulo = qScore ? String(txt(qScore.title)).slice(0, 90)
                        : (i.tipo === 'NPS' ? 'Recomendación (NPS)' : 'Satisfacción');
    var g = tarjeta(rotulo, i.n,
      i.tipo === 'NPS'
        ? 'NPS = promotores − detractores, sobre 100.'
        : '% CSAT = notas 4 y 5 sobre el total.');
    g.classList.add('is-ancho');

    var colores = i.tipo === 'NPS'
      ? [ESTADOS.malo, ESTADOS.medio, ESTADOS.bueno]
      : [ESTADOS.malo, ESTADOS.medio, ESTADOS.bueno];
    apilada(g, i.grupos.map(function (gr, k) {
      return { texto: gr.texto, n: gr.n, color: colores[k] };
    }), i.n);

    // Distribución nota a nota, en una sola tonalidad.
    var d = A.distribucion(datos, qScore);
    var sep = el('div', 'sbq-g-sub');
    sep.style.marginTop = '18px';
    sep.textContent = 'Distribución de notas';
    g.appendChild(sep);
    barras(g, d.items.map(function (it) {
      return { etiqueta: 'Nota ' + it.valor, n: it.n, pct: it.pct };
    }));

    tabla(g, ['Grupo', 'n', '%'], i.grupos.map(function (gr) {
      return [gr.texto, num(gr.n), pct(gr.n / i.n)];
    }));
    refs.graficos.appendChild(g);
  }

  /** Evolución del indicador. Línea de una sola serie, sin leyenda. */
  function graficoSerie(datos) {
    var serie = A.serieTemporal(datos, survey, 'mes');
    if (serie.length < 2) return;

    var esNPS = Model.tipoDeIndicador(survey) === 'NPS';
    var g = tarjeta('Evolución mensual', null,
      esNPS ? 'NPS por mes. El tamaño de la muestra va bajo cada punto.'
            : '% CSAT por mes. El tamaño de la muestra va bajo cada punto.');
    g.classList.add('is-ancho');

    var W = 760, H = 210, ml = 44, mr = 16, mt = 14, mb = 44;
    var ancho = W - ml - mr, alto = H - mt - mb;
    var vals = serie.map(function (s) { return esNPS ? s.valor : s.valor * 100; });
    var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
    // Un poco de aire arriba y abajo, y nunca un rango de cero.
    var lo = Math.floor((min - (max - min) * 0.25 - 1) / 5) * 5;
    var hi = Math.ceil((max + (max - min) * 0.25 + 1) / 5) * 5;
    if (hi === lo) { hi = lo + 10; }
    if (!esNPS) { lo = Math.max(0, lo); hi = Math.min(100, hi); }

    var x = function (i) { return ml + (serie.length === 1 ? ancho / 2 : i / (serie.length - 1) * ancho); };
    var y = function (v) { return mt + alto - (v - lo) / (hi - lo) * alto; };

    var svg = ['<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Evolución mensual del indicador">'];

    // Grilla: hairline sólida, un tono sobre el fondo. Nunca punteada.
    var pasos = 4;
    for (var k = 0; k <= pasos; k++) {
      var v = lo + (hi - lo) * k / pasos;
      svg.push('<line x1="' + ml + '" y1="' + y(v).toFixed(1) + '" x2="' + (W - mr) +
               '" y2="' + y(v).toFixed(1) + '" stroke="var(--grid)" stroke-width="1"/>');
      svg.push('<text x="' + (ml - 8) + '" y="' + (y(v) + 3.5).toFixed(1) +
               '" text-anchor="end" font-size="10" fill="var(--muted)">' +
               (esNPS ? Math.round(v) : Math.round(v) + '%') + '</text>');
    }

    var d = serie.map(function (s, i) {
      return (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(esNPS ? s.valor : s.valor * 100).toFixed(1);
    }).join(' ');
    svg.push('<path d="' + d + '" fill="none" stroke="var(--barra)" stroke-width="2" ' +
             'stroke-linejoin="round" stroke-linecap="round"/>');

    serie.forEach(function (s, i) {
      var vy = y(esNPS ? s.valor : s.valor * 100);
      // Anillo del color de la superficie, para que el punto no se pegue a la línea.
      svg.push('<circle cx="' + x(i).toFixed(1) + '" cy="' + vy.toFixed(1) +
               '" r="4.5" fill="var(--barra)" stroke="var(--surface)" stroke-width="2"/>');
      svg.push('<text x="' + x(i).toFixed(1) + '" y="' + (H - mb + 18) +
               '" text-anchor="middle" font-size="10.5" fill="var(--text-2)">' + esc(s.periodo) + '</text>');
      svg.push('<text x="' + x(i).toFixed(1) + '" y="' + (H - mb + 32) +
               '" text-anchor="middle" font-size="9.5" fill="var(--muted)">n=' + s.n + '</text>');
    });

    // Solo los extremos llevan número: uno en cada punto sería ilegible.
    [0, serie.length - 1].forEach(function (i) {
      if (serie.length < 2) return;
      var s = serie[i];
      var vv = esNPS ? s.valor : s.valor * 100;
      svg.push('<text x="' + x(i).toFixed(1) + '" y="' + (y(vv) - 11).toFixed(1) +
               '" text-anchor="' + (i === 0 ? 'start' : 'end') +
               '" font-size="11" font-weight="600" fill="var(--text)">' +
               (esNPS ? Math.round(vv) : vv.toFixed(1) + '%') + '</text>');
    });

    svg.push('</svg>');
    var cont = el('div', 'sbq-serie', svg.join(''));
    g.appendChild(cont);

    tabla(g, ['Mes', 'n', esNPS ? 'NPS' : '% CSAT', 'Promedio'],
      serie.map(function (s) {
        return [s.periodo, num(s.n),
                esNPS ? Math.round(s.valor) : pct(s.valor),
                s.promedio.toFixed(2)];
      }));
    refs.graficos.appendChild(g);
  }

  /** Elige el gráfico según lo que la pregunta mide. */
  function graficoPregunta(q, datos) {
    var titulo = String(txt(q.title) || q.id).slice(0, 110);

    if (q.type === 'matrix')       return graficoMatriz(q, datos, titulo);
    if (q.type === 'ranking')      return graficoRanking(q, datos, titulo);
    if (q.type === 'comment' || q.type === 'text' || q.type === 'multipletext') {
      return graficoTexto(q, datos, titulo);
    }
    if (q.type === 'file' || q.type === 'signature') return graficoConteo(q, datos, titulo);

    // Alternativas y escalas: distribución en barras.
    var d = A.distribucion(datos, q);
    if (!d.items.length) return;

    var g = tarjeta(titulo, d.personas,
      d.multi
        ? 'Opción múltiple: el porcentaje es sobre quienes respondieron, y suma más de 100%.'
        : null);

    var items = d.items.map(function (it) {
      return { etiqueta: etiqueta(q, it.valor), n: it.n, pct: it.pct };
    });
    // Las escalas conservan su orden natural; el resto se ordena por frecuencia.
    if (q.type !== 'rating') items.sort(function (a, b) { return b.n - a.n; });

    barras(g, items);
    tabla(g, ['Opción', 'n', '%'], items.map(function (i) {
      return [i.etiqueta, num(i.n), pct(i.pct)];
    }));
    refs.graficos.appendChild(g);
  }

  /** Matriz: una barra apilada por fila, más su promedio. */
  function graficoMatriz(q, datos, titulo) {
    var filas = A.matriz(datos, q).filter(function (f) { return f.n; });
    if (!filas.length) return;

    var g = tarjeta(titulo, Math.max.apply(null, filas.map(function (f) { return f.n; })),
      'Cada barra reparte las respuestas de esa fila.');
    g.classList.add('is-ancho');

    // La escala de la matriz es ordinal: de peor a mejor. Se usa la trilogía
    // de estados solo si tiene 3 columnas; con más, una rampa de una tonalidad.
    var cols = q.columns || [];
    var colores = cols.map(function (c, i) {
      if (cols.length === 3) return [ESTADOS.malo, ESTADOS.medio, ESTADOS.bueno][i];
      var t = cols.length === 1 ? 1 : i / (cols.length - 1);
      return 'color-mix(in srgb, var(--barra) ' + Math.round(25 + t * 75) + '%, var(--barra-suave))';
    });

    filas.forEach(function (f) {
      var fila = el('div', 'sbq-mfila');
      fila.appendChild(el('div', 'sbq-barra-lbl', esc(String(txt(f.fila.text)))));

      var barra = el('div', 'sbq-apilada');
      f.columnas.forEach(function (c, i) {
        if (!c.n) return;
        var d = el('div', null, c.pct > 0.1 ? pct(c.pct, 0) : '');
        d.style.background = colores[i];
        d.style.flex = String(c.n);
        d.dataset.tip = txt(f.fila.text) + ' · ' + txt(c.col.text) + ': ' + num(c.n) + ' · ' + pct(c.pct);
        barra.appendChild(d);
      });
      fila.appendChild(barra);

      var prom = el('div', 'sbq-barra-num');
      prom.innerHTML = f.promedio != null ? '<b>' + f.promedio.toFixed(2) + '</b>' : '—';
      prom.title = 'Promedio de la fila';
      fila.appendChild(prom);
      g.appendChild(fila);
    });

    var ley = el('div', 'sbq-leyenda');
    cols.forEach(function (c, i) {
      var sp = el('span', null, esc(String(txt(c.text))));
      var ic = doc.createElement('i');
      ic.style.background = colores[i];
      sp.insertBefore(ic, sp.firstChild);
      ley.appendChild(sp);
    });
    g.appendChild(ley);

    tabla(g, ['Fila', 'n', 'Promedio'].concat(cols.map(function (c) { return String(txt(c.text)); })),
      filas.map(function (f) {
        return [String(txt(f.fila.text)), num(f.n),
                f.promedio != null ? f.promedio.toFixed(2) : '—']
          .concat(f.columnas.map(function (c) { return num(c.n); }));
      }));
    refs.graficos.appendChild(g);
  }

  /** Ordenamiento: posición promedio. Más corto es mejor. */
  function graficoRanking(q, datos, titulo) {
    var r = A.ranking(datos, q);
    if (!r.length) return;

    var g = tarjeta(titulo, Math.max.apply(null, r.map(function (x) { return x.n; })),
      'Posición promedio: 1 es lo más prioritario.');
    var peor = Math.max.apply(null, r.map(function (x) { return x.posicion; }));

    var cont = el('div', 'sbq-barras');
    r.forEach(function (x) {
      var fila = el('div', 'sbq-barra-fila');
      fila.appendChild(el('div', 'sbq-barra-lbl', esc(String(txt(x.opcion.text)))));
      var pista = el('div', 'sbq-barra-pista');
      var val = el('div', 'sbq-barra-val');
      // Invertida: la barra más larga es la mejor posición.
      val.style.width = ((peor - x.posicion + 0.4) / peor * 100) + '%';
      val.dataset.tip = txt(x.opcion.text) + ': posición ' + x.posicion.toFixed(2) + ' · n = ' + x.n;
      pista.appendChild(val);
      fila.appendChild(pista);
      var numero = el('div', 'sbq-barra-num');
      numero.innerHTML = '<b>' + x.posicion.toFixed(2) + '</b>';
      fila.appendChild(numero);
      cont.appendChild(fila);
    });
    g.appendChild(cont);

    tabla(g, ['Opción', 'Posición promedio', 'n'], r.map(function (x) {
      return [String(txt(x.opcion.text)), x.posicion.toFixed(2), num(x.n)];
    }));
    refs.graficos.appendChild(g);
  }

  /** Texto libre: palabras frecuentes y los comentarios. */
  function graficoTexto(q, datos, titulo) {
    var vb = A.verbatims(datos, q);
    if (!vb.length) return;

    var g = tarjeta(titulo, vb.length, null, q.type === 'comment');
    var pal = A.palabras(datos, q, 26);

    if (pal.length) {
      var maxN = pal[0].n;
      var nube = el('div', 'sbq-nube');
      pal.forEach(function (p) {
        var s = el('span', null, esc(p.palabra));
        // El tamaño codifica la frecuencia; el color se queda en tokens de
        // texto, sin convertirse en un segundo canal.
        s.style.fontSize = (0.78 + (p.n / maxN) * 0.85).toFixed(2) + 'rem';
        s.style.fontWeight = p.n / maxN > 0.5 ? '650' : '400';
        s.style.color = p.n / maxN > 0.5 ? 'var(--text)' : 'var(--text-2)';
        s.dataset.tip = p.palabra + ': ' + p.n + ' menciones';
        nube.appendChild(s);
      });
      g.appendChild(nube);
      g.appendChild(el('div', 'sbq-g-sub',
        'Palabras con más de una mención, sin artículos ni preposiciones.'));
    }

    var lista = el('div', 'sbq-verbatims');
    lista.style.marginTop = '12px';
    vb.slice(0, 60).forEach(function (v) {
      var c = el('div', 'sbq-verbatim');
      c.appendChild(el('div', null, esc(v.texto)));
      var contexto = [v.contexto.touchpoint, v.contexto.palanca,
                      v.fecha ? String(v.fecha).slice(0, 10) : null]
        .filter(Boolean).join(' · ');
      if (contexto) c.appendChild(el('div', 'sbq-verbatim-meta', esc(contexto)));
      lista.appendChild(c);
    });
    g.appendChild(lista);
    if (vb.length > 60) {
      g.appendChild(el('div', 'sbq-g-sub',
        'Se muestran 60 de ' + num(vb.length) + '. Exporta el CSV para verlos todos.'));
    }
    refs.graficos.appendChild(g);
  }

  /** Adjuntos y firmas: el dato es cuántos, no cuáles. */
  function graficoConteo(q, datos, titulo) {
    var con = datos.filter(function (r) { return A.codigosDe(r, q.id).length; }).length;
    if (!con) return;
    var g = tarjeta(titulo, datos.length);
    var k = el('div', 'sbq-kpi-valor');
    k.textContent = num(con);
    g.appendChild(k);
    g.appendChild(el('div', 'sbq-kpi-nota',
      'respuestas con ' + (q.type === 'file' ? 'archivo adjunto' : 'firma') +
      ' · ' + pct(con / datos.length, 0) + ' del total'));
    refs.graficos.appendChild(g);
  }

  // ------------------------------------------------------------- arranque

  global.SBQ_PANEL = {
    get datos() { return todas; },
    get filtrados() { return aplicarFiltros(); },
    get survey() { return survey; },
    cargar: function (d, id) {
      todas = d; fuente = 'prueba';
      if (id) { refs.picker.value = id; survey = Model.normalize(SBQ.getSurvey(id)); }
      dibujar();
    },
    filtrar: function (f) { filtros = f; dibujar(); }
  };

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot);
  else boot();

})(typeof window !== 'undefined' ? window : globalThis);
