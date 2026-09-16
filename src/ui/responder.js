/*!
 * surveyBQ — responder.js
 * Aplicación del respondedor: carga una encuesta, la recorre y guarda el
 * resultado. Pensada para abrirse desde un QR en el punto de servicio.
 *
 * Parámetros de URL admitidos:
 *   ?survey=demo-tipos            encuesta a mostrar (obligatorio)
 *   &touchpoint=Baños              precarga y oculta esa pregunta
 *   &sector=A                      idem, para cualquier id de pregunta
 *   &cc=SITIO-01                   sobrescribe la variable centro_comercial
 *   &canal=qr-sector-a             etiqueta de origen que viaja a BigQuery
 *
 * Ejemplo de QR para un sector:
 *   responder.html?survey=demo-tipos&touchpoint=Recepcion&canal=qr-entrada
 */
(function (global) {
  'use strict';

  var SBQ = global.SBQ;
  var doc = global.document;
  var render = SBQ.render;
  var el = render.el;
  var esc = SBQ.util.esc;

  var rt = null;
  var survey = null;
  var params = SBQ.util.queryParams();
  var refs = {};
  var guardadoParcial = false;
  var paginaDibujada = null;   // para no volver al inicio en cada respuesta

  // ------------------------------------------------------------------ inicio

  function boot() {
    refs.root     = doc.getElementById('sbq-root');
    refs.progress = doc.getElementById('sbq-progress-bar');
    refs.nav      = doc.getElementById('sbq-nav');
    refs.title    = doc.getElementById('sbq-survey-title');
    refs.step     = doc.getElementById('sbq-step');

    var id = params.survey || params.encuesta;

    // Sin encuesta indicada (alguien entró a la URL raíz en vez de escanear el
    // QR) se ofrece la lista en vez de un error: en el despliegue público el
    // respondedor es lo único que existe.
    if (!id) return selector();

    // Si el editor publicó una versión nueva, se usa esa. Se espera poco y
    // con red mala se sigue con la del archivo: la encuesta tiene que
    // abrirse igual en un subterráneo.
    var hayLocal = SBQ.storage.loadDraft && SBQ.storage.loadDraft(id);
    if (!SBQ.publicadas[id] && !hayLocal) {
      SBQ.traerPublicada(id, 1200).then(function () { continuarBoot(id); });
      return;
    }
    continuarBoot(id);
  }

  function continuarBoot(id) {
    survey = SBQ.getSurvey(id);
    if (!survey) return selector('No encontramos la encuesta «' + esc(id) + '».');

    // Normalizada: una encuesta escrita a mano —o creada en el editor— puede
    // no traer settings ni variables, y el respondedor los da por hechos.
    survey = SBQ.Model.normalize(SBQ.util.clone(survey));
    // Cualquier variable declarada por la encuesta se puede fijar desde la URL
    // (?periodo=Junio%202026). Es lo que permite reutilizar la misma encuesta
    // cada mes sin tener que editarla.
    Object.keys(survey.variables || {}).forEach(function (k) {
      if (params[k] !== undefined && params[k] !== '') survey.variables[k] = params[k];
    });
    if (params.cc) survey.variables.centro_comercial = params.cc;

    var soloLectura = params.modo === 'lectura';

    rt = new SBQ.Runtime(survey, {
      prefill: construirPrefill(survey),
      source: params.canal || params.source || 'web',
      locale: idiomaInicial(survey),
      readOnly: soloLectura,
      onComplete: alCompletar
    });

    // Presentación primero: vale para todas las ramas, incluidas la de solo
    // lectura y la de retomar.
    if (SBQ.theme) SBQ.theme.apply(survey.theme);
    if (refs.title) refs.title.textContent = rt.t(survey.title);
    doc.title = rt.t(survey.title) + ' · surveyBQ';
    dibujarSelectorIdioma();

    if (soloLectura) return modoLectura();

    // Sesión a medio hacer: se ofrece, no se impone. Alguien puede querer
    // empezar de nuevo, y retomar sin preguntar le quitaría esa opción.
    var sesion = SBQ.storage.loadSession(survey.id);
    if (sesion && !params.nueva) return ofrecerRetomar(sesion);

    arrancar();
  }

  /** Pone en marcha el recorrido: reloj, aviso de salida y primer dibujo. */
  function arrancar() {
    // removeEventListener antes de agregar: si se pasó por la pantalla de
    // retomar y se eligió empezar de nuevo, arrancar() corre dos veces.
    global.removeEventListener('beforeunload', guardarParcial);
    global.addEventListener('beforeunload', guardarParcial);

    rt.startTimer(function (restante) { dibujarReloj(restante); });
    dibujarReloj(rt.tiempoRestante());
    dibujar();
  }

  /**
   * Toma de la URL los valores que coinciden con un id de pregunta y marca
   * cada uno con <id>_fijado, que es lo que usan los visibleIf para no volver
   * a preguntar algo que ya viene del QR.
   */
  function construirPrefill(sv) {
    var prefill = {};
    var ids = {};
    // Normalizada, para no depender de cómo estén escritas las opciones.
    SBQ.Model.allQuestions(SBQ.Model.normalize(sv)).forEach(function (q) { ids[q.id] = q; });

    Object.keys(params).forEach(function (k) {
      if (!ids[k]) return;
      var q = ids[k];
      var v = params[k];

      if (q.type === 'rating') v = Number(v);
      else if (q.type === 'checkbox') v = v.split('|').map(function (s) { return s.trim(); });

      prefill[k] = v;
      prefill[k + '_fijado'] = 'si';
    });
    return prefill;
  }

  /**
   * Idioma de partida: manda el parámetro de URL; si no, el del navegador
   * cuando la encuesta lo tenga traducido; si no, el propio de la encuesta.
   */
  function idiomaInicial(sv) {
    var disponibles = SBQ.Model.locales(SBQ.Model.normalize(sv));
    var pedido = params.lang || params.idioma;
    if (pedido && disponibles.indexOf(pedido) >= 0) return pedido;

    var navegador = (global.navigator && global.navigator.language || '')
      .slice(0, 2).toLowerCase();
    if (navegador && disponibles.indexOf(navegador) >= 0) return navegador;

    return sv.locale || 'es';
  }

  /** Selector de idioma. Solo aparece si la encuesta está traducida. */
  function dibujarSelectorIdioma() {
    var cont = doc.getElementById('sbq-locale');
    if (!cont) return;
    cont.innerHTML = '';

    var idiomas = rt.availableLocales();
    if (idiomas.length < 2) return;

    var caja = el('div', 'sbq-locale');
    idiomas.forEach(function (loc) {
      var b = el('button', loc === rt.locale ? 'is-on' : '', esc(loc));
      b.type = 'button';
      b.setAttribute('lang', loc);
      b.onclick = function () {
        rt.setLocale(loc);
        dibujarSelectorIdioma();
        dibujar();
      };
      caja.appendChild(b);
    });
    cont.appendChild(caja);
  }

  /** Ofrece retomar una sesión guardada. */
  function ofrecerRetomar(sesion) {
    refs.root.innerHTML = '';
    refs.nav.style.display = 'none';
    var cuando = new Date(sesion.saved_at);

    var card = el('div', 'sbq-card sbq-retomar');
    card.appendChild(el('h2', null, 'Tienes una respuesta a medio hacer'));
    card.appendChild(el('p', 'sbq-muted',
      'La empezaste el ' + cuando.toLocaleDateString('es-CL') + ' a las ' +
      cuando.toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' }) +
      '. Puedes seguir donde quedaste o partir de nuevo.'));

    var fila = el('div', 'sbq-row');
    var seguir = el('button', 'sbq-btn sbq-btn-primary', 'Seguir donde quedé');
    seguir.onclick = function () { rt.restore(sesion); arrancar(); };
    var nueva = el('button', 'sbq-btn', 'Empezar de nuevo');
    nueva.onclick = function () { SBQ.storage.clearSession(survey.id); arrancar(); };
    fila.appendChild(seguir);
    fila.appendChild(nueva);
    card.appendChild(fila);
    refs.root.appendChild(card);
  }

  /** Revisar una respuesta ya enviada, en la misma interfaz. */
  function modoLectura() {
    var guardadas = SBQ.storage.listResponses(survey.id);
    var r = params.respuesta
      ? guardadas.filter(function (x) { return x.response_id === params.respuesta; })[0]
      : guardadas[guardadas.length - 1];

    if (!r) {
      refs.root.innerHTML = '';
      refs.nav.style.display = 'none';
      var card = el('div', 'sbq-card sbq-retomar');
      card.appendChild(el('h2', null, 'No se pudo mostrar la respuesta'));
      card.appendChild(el('p', 'sbq-muted',
        'No se encontró esa respuesta en este dispositivo.'));
      refs.root.appendChild(card);
      return;
    }

    rt.values = SBQ.util.clone(r.values || {});
    // La respuesta se muestra en el idioma en que se respondió, no en el del
    // navegador de quien la revisa.
    rt.locale = r.locale || rt.locale;
    dibujarSelectorIdioma();
    dibujar();
  }

  /** Cuenta regresiva. Solo aparece si la encuesta tiene límite de tiempo. */
  function dibujarReloj(restante) {
    var cont = doc.getElementById('sbq-reloj');
    if (!cont) return;
    if (!restante || (restante.total === null && restante.pagina === null)) {
      cont.innerHTML = '';
      return;
    }
    // Manda el más apremiante de los dos límites.
    var seg = [restante.total, restante.pagina]
      .filter(function (x) { return x !== null; })
      .reduce(function (a, b) { return Math.min(a, b); });
    seg = Math.max(0, seg);

    var mm = Math.floor(seg / 60), ss = seg % 60;
    var clase = seg <= 10 ? ' es-critico' : (seg <= 30 ? ' es-poco' : '');
    cont.innerHTML = '';
    var caja = el('div', 'sbq-reloj' + clase, '⏱ ' + mm + ':' + (ss < 10 ? '0' : '') + ss);
    caja.setAttribute('role', 'timer');
    caja.setAttribute('aria-live', seg <= 30 ? 'assertive' : 'off');
    cont.appendChild(caja);
  }

  /** Lista de encuestas disponibles, para quien llegó sin QR. */
  function selector(aviso) {
    refs.root.innerHTML = '';
    if (refs.nav) refs.nav.style.display = 'none';
    if (refs.progress) refs.progress.style.width = '0';

    var card = el('div', 'sbq-card');
    card.appendChild(el('h2', null, '¿Qué quieres responder?'));
    if (aviso) card.appendChild(el('p', 'sbq-muted', aviso));

    var ids = Object.keys(SBQ.surveys);
    if (!ids.length) {
      card.appendChild(el('div', 'sbq-empty', 'No hay encuestas disponibles.'));
      refs.root.appendChild(card);
      return;
    }

    var lista = el('div', 'sbq-stack');
    lista.style.marginTop = '16px';
    ids.forEach(function (k) {
      var sv = SBQ.getSurvey(k);
      var a = el('a', 'sbq-choice');
      a.href = 'responder.html?survey=' + encodeURIComponent(k);
      a.style.textDecoration = 'none';
      a.style.color = 'inherit';
      var txt = el('span', 'sbq-choice-text', esc(sv.title));
      if (sv.description) txt.appendChild(el('span', 'sbq-choice-desc', esc(sv.description)));
      a.appendChild(txt);
      lista.appendChild(a);
    });
    card.appendChild(lista);
    refs.root.appendChild(card);
  }

  // ------------------------------------------------------------------ dibujo

  function dibujar() {
    if (rt.state === 'completed')    return pantallaFinal(survey.settings.thankYou, '✓', false);
    if (rt.state === 'disqualified') return pantallaFinal(survey.settings.disqualified, '👋', true);

    var page = rt.currentPage();
    refs.root.innerHTML = '';

    if (!page) {
      refs.root.appendChild(el('div', 'sbq-card',
        '<div class="sbq-empty">Esta encuesta no tiene páginas visibles.</div>'));
      return;
    }

    if (rt.readOnly) {
      refs.root.appendChild(el('div', 'sbq-lectura-aviso',
        '👁 Estás viendo una respuesta enviada. No se puede modificar.'));
    }
    refs.root.appendChild(render.page(page, rt, alEscribir, { showFlags: false }));
    actualizarNav();
    actualizarProgreso();
    // También acá, no solo en cada tick: al cambiar de página el reloj de la
    // anterior quedaría a la vista hasta un segundo. En solo lectura no hay
    // nada que cronometrar.
    if (rt.tieneLimite() && !rt.readOnly) dibujarReloj(rt.tiempoRestante());

    // Enfocar el primer error para que se vea de inmediato en el teléfono.
    var primerError = refs.root.querySelector('.sbq-q.has-error');
    if (primerError) {
      primerError.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else if (page.id !== paginaDibujada) {
      // Solo al cambiar de página. Cada respuesta redibuja, y subir al inicio
      // en cada clic haría imposible completar una matriz o una página larga.
      global.scrollTo({ top: 0, behavior: 'smooth' });
    }
    paginaDibujada = page.id;
  }

  /**
   * @param {boolean} sinRedibujar true para inputs de texto: cambiar el DOM en
   *        cada tecla haría perder el foco y el cursor.
   */
  function alEscribir(id, value, sinRedibujar) {
    rt.setValue(id, value);
    guardarSesion();
    if (sinRedibujar) {
      actualizarProgreso();
      actualizarNav();
      return;
    }
    dibujar();
  }

  function actualizarProgreso() {
    if (!refs.progress || !survey.settings.showProgress) return;
    var pages = rt.visiblePages().length;
    var pct = pages ? Math.round(((rt.pageIndex + rt.answeredRatio() * 0.35) / pages) * 100) : 0;
    refs.progress.style.width = Math.min(100, Math.max(4, pct)) + '%';

    if (refs.step) {
      refs.step.textContent = 'Paso ' + (rt.pageIndex + 1) + ' de ' + pages;
    }
  }

  function actualizarNav() {
    refs.nav.innerHTML = '';
    if (rt.readOnly) { refs.nav.style.display = 'none'; return; }
    var inner = el('div', 'sbq-nav-inner');

    if (!rt.isFirstPage()) {
      var atras = el('button', 'sbq-btn', 'Atrás');
      atras.type = 'button';
      atras.onclick = function () { rt.prev(); dibujar(); };
      inner.appendChild(atras);
    }

    var siguiente = el('button', 'sbq-btn sbq-btn-primary',
      rt.isLastPage() ? 'Enviar respuesta' : 'Continuar');
    siguiente.type = 'button';
    siguiente.onclick = function () {
      rt.next();
      guardarSesion();
      // El screener no dispara onComplete, pero la respuesta igual importa:
      // es el equivalente al "Finalizado = Falso" de Qualtrics.
      if (rt.state === 'disqualified' && !guardadoParcial) alCompletar(rt.result());
      dibujar();
    };
    inner.appendChild(siguiente);

    refs.nav.appendChild(inner);
    refs.nav.style.display = '';
  }

  // -------------------------------------------------------------- cierre ---

  function pantallaFinal(cfg, icono, neutral) {
    cfg = cfg || {};
    refs.root.innerHTML = '';
    refs.nav.style.display = 'none';
    if (refs.progress) refs.progress.style.width = '100%';
    if (refs.step) refs.step.textContent = '';

    var card = el('div', 'sbq-card sbq-final');
    card.appendChild(el('div', 'sbq-final-icon' + (neutral ? ' is-neutral' : ''), icono));
    if (rt.timedOut) {
      card.appendChild(el('p', 'sbq-badge is-warn',
        'Se acabó el tiempo. Se guardó lo que alcanzaste a responder.'));
    }
    card.appendChild(el('h2', null, esc(rt.t(cfg.title) || '¡Listo!')));
    card.appendChild(el('p', 'sbq-muted',
      esc(rt.t(cfg.text) || 'Gracias por responder.')));

    var acciones = el('div', 'sbq-row', '');
    acciones.style.justifyContent = 'center';
    acciones.style.marginTop = '20px';

    var otra = el('button', 'sbq-btn', 'Responder otra vez');
    otra.type = 'button';
    otra.onclick = function () { global.location.reload(); };
    acciones.appendChild(otra);
    card.appendChild(acciones);

    if (refs.estado) card.appendChild(refs.estado);
    refs.root.appendChild(card);
  }

  function alCompletar(result) {
    global.removeEventListener('beforeunload', guardarParcial);
    guardadoParcial = true;
    clearTimeout(timerSesion);
    SBQ.storage.clearSession(survey.id);

    var total = SBQ.storage.saveResponse(result);
    refs.estado = el('p', 'sbq-muted');
    refs.estado.style.marginTop = '16px';
    refs.estado.textContent = (result.status === 'disqualified'
      ? 'Registrada como fuera de perfil'
      : 'Guardada localmente') + ' (' + total + ' en este dispositivo).';

    var cfg = SBQ.storage.getConfig(result && result.survey_id);
    if (cfg.endpoint) {
      SBQ.storage.autoReintentar();
      SBQ.storage.send(result).then(function (r) {
        refs.estado.textContent = r.sent
          ? 'Enviada al servidor correctamente.'
          : 'Sin conexión: quedó en cola para reintentar (' + SBQ.storage.queueLength() + ' pendientes).';
      });
    }
  }

  /* Autoguardado con freno: escribir en localStorage en cada tecla de un
     comentario largo es trabajo tirado. Basta con guardar al reposar. */
  var timerSesion = null;
  function guardarSesion() {
    if (!rt || rt.readOnly || rt.state !== 'running') return;
    clearTimeout(timerSesion);
    timerSesion = setTimeout(function () {
      SBQ.storage.saveSession(rt.snapshot());
    }, 600);
  }

  /**
   * Registra el abandono, igual que el "Finalizado = Falso" de Qualtrics.
   * Solo si alcanzó a responder algo: las variables de la encuesta siempre
   * están presentes en values y no cuentan como respuesta.
   */
  function guardarParcial() {
    if (guardadoParcial || !rt || rt.state !== 'running') return;
    var parcial = rt.result();
    if (!parcial.answers.length) return;
    parcial.status = 'partial';
    SBQ.storage.saveResponse(parcial);
    guardadoParcial = true;
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot);
  else boot();

})(typeof window !== 'undefined' ? window : globalThis);
