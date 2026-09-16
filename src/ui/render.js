/*!
 * surveyBQ — render.js
 * Dibuja preguntas a partir del modelo. Lo usan tanto el respondedor como la
 * vista previa del editor, así que lo que se ve editando es exactamente lo que
 * verá quien responde.
 */
(function (global) {
  'use strict';

  var SBQ = global.SBQ || (global.SBQ = {});
  var Model = SBQ.Model;
  var esc = SBQ.util.esc;

  var EMOJI_5 = ['😠', '🙁', '😐', '🙂', '😄'];

  function el(tag, cls, html) {
    var n = global.document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }

  /** Tono de color para las escalas (CSAT 1-5 y NPS 0-10). */
  function toneFor(q, value) {
    if (q.colorScale === 'nps' || (q.rateMin === 0 && q.rateMax === 10)) {
      if (value <= 6) return 'tone-bad';
      if (value <= 8) return 'tone-mid';
      return 'tone-good';
    }
    var span = q.rateMax - q.rateMin;
    var pos = (value - q.rateMin) / (span || 1);
    if (pos < 0.4) return 'tone-bad';
    if (pos < 0.7) return 'tone-mid';
    return 'tone-good';
  }

  // --------------------------------------------------------------- controles

  function renderRating(q, rt, onInput) {
    var wrap = el('div', 'sbq-rating');
    var current = rt.getValue(q.id);
    var values = [];
    for (var v = q.rateMin; v <= q.rateMax; v += (q.rateStep || 1)) values.push(v);

    var items = el('div', 'sbq-rating-items' + (values.length > 6 ? ' is-wide' : ''));

    values.forEach(function (v) {
      var selected = current !== undefined && Number(current) === v;
      var btn = el('button', 'sbq-rate' + (selected ? ' is-selected ' + toneFor(q, v) : ''));
      btn.type = 'button';
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', selected ? 'true' : 'false');

      if (q.displayMode === 'emoji' && q.rateMin === 1 && q.rateMax === 5) {
        btn.appendChild(el('span', 'sbq-emoji', EMOJI_5[v - 1]));
        btn.appendChild(el('span', 'sbq-rate-num', String(v)));
        btn.setAttribute('aria-label', v + ' de ' + q.rateMax);
      } else {
        btn.appendChild(el('span', 'sbq-rate-num', String(v)));
      }

      btn.onclick = function () {
        // Volver a tocar la nota elegida la deselecciona.
        onInput(q.id, selected ? undefined : v);
      };
      items.appendChild(btn);
    });

    wrap.appendChild(items);

    if (q.minLabel || q.maxLabel) {
      var labels = el('div', 'sbq-rating-labels');
      labels.appendChild(el('span', null, esc(rt.t(q.minLabel) || '')));
      labels.appendChild(el('span', null, esc(rt.t(q.maxLabel) || '')));
      wrap.appendChild(labels);
    }
    return wrap;
  }

  function renderChoices(q, rt, onInput, multiple) {
    var wrap = el('div', 'sbq-choices');
    var current = rt.getValue(q.id);
    var selectedList = Array.isArray(current) ? current : (current !== undefined ? [current] : []);
    var choices = rt.choicesFor(q);
    var name = 'q_' + q.id;

    choices.forEach(function (c, i) {
      var isSel = selectedList.some(function (x) { return x === c.value; });
      var label = el('label', 'sbq-choice' + (isSel ? ' is-selected' : ''));

      var input = global.document.createElement('input');
      input.type = multiple ? 'checkbox' : 'radio';
      input.name = name;
      input.value = String(c.value);
      input.checked = isSel;
      input.id = name + '_' + i;

      input.onchange = function () {
        if (multiple) {
          rt.toggleChoice(q, c.value, input.checked);
          // Sin redibujar no aparecería el campo libre de "Otro" ni se
          // actualizarían las preguntas que dependen de esta.
          onInput(q.id, rt.getValue(q.id));
        } else {
          onInput(q.id, c.value);
        }
      };

      var txt = el('span', 'sbq-choice-text', esc(rt.t(c.text)));
      if (c.description) txt.appendChild(el('span', 'sbq-choice-desc', esc(rt.t(c.description))));

      label.appendChild(input);
      label.appendChild(txt);
      wrap.appendChild(label);

      // Campo libre para la opción "Otro".
      if (c.isOther && isSel) {
        var otherWrap = el('div', 'sbq-other-wrap');
        var otherInput = global.document.createElement('input');
        otherInput.type = 'text';
        otherInput.className = 'sbq-input';
        otherInput.placeholder = rt.t(q.otherPlaceholder) || 'Cuéntanos brevemente';
        otherInput.value = rt.getValue(q.id + '_otro') || '';
        otherInput.oninput = function () { onInput(q.id + '_otro', otherInput.value, true); };
        otherWrap.appendChild(otherInput);
        wrap.appendChild(otherWrap);
      }
    });

    return wrap;
  }

  function renderDropdown(q, rt, onInput) {
    var current = rt.getValue(q.id);
    var sel = el('select', 'sbq-select');
    var ph = global.document.createElement('option');
    ph.value = '';
    ph.textContent = rt.t(q.placeholder) || 'Selecciona una opción';
    sel.appendChild(ph);

    rt.choicesFor(q).forEach(function (c) {
      var o = global.document.createElement('option');
      o.value = String(c.value);
      o.textContent = rt.t(c.text);
      if (current !== undefined && String(current) === String(c.value)) o.selected = true;
      sel.appendChild(o);
    });

    sel.onchange = function () { onInput(q.id, sel.value || undefined); };

    var wrap = el('div');
    wrap.appendChild(sel);

    if (q.hasOther && current === SBQ.Runtime.OTHER) {
      var otherInput = global.document.createElement('input');
      otherInput.type = 'text';
      otherInput.className = 'sbq-input';
      otherInput.style.marginTop = '8px';
      otherInput.placeholder = rt.t(q.otherPlaceholder) || 'Cuéntanos brevemente';
      otherInput.value = rt.getValue(q.id + '_otro') || '';
      otherInput.oninput = function () { onInput(q.id + '_otro', otherInput.value, true); };
      wrap.appendChild(otherInput);
    }
    return wrap;
  }

  function renderText(q, rt, onInput) {
    var input = global.document.createElement('input');
    input.type = q.inputType || 'text';
    input.className = 'sbq-input';
    input.placeholder = rt.t(q.placeholder) || '';
    input.value = rt.getValue(q.id) || '';
    if (q.maxLength) input.maxLength = q.maxLength;
    input.oninput = function () { onInput(q.id, input.value, true); };
    return input;
  }

  function renderComment(q, rt, onInput) {
    var wrap = el('div');
    var ta = global.document.createElement('textarea');
    ta.className = 'sbq-textarea';
    ta.rows = q.rows || 4;
    ta.placeholder = rt.t(q.placeholder) || '';
    ta.value = rt.getValue(q.id) || '';
    if (q.maxLength) ta.maxLength = q.maxLength;
    wrap.appendChild(ta);

    var counter = null;
    if (q.maxLength) {
      counter = el('div', 'sbq-counter', (ta.value.length) + ' / ' + q.maxLength);
      wrap.appendChild(counter);
    }
    ta.oninput = function () {
      if (counter) counter.textContent = ta.value.length + ' / ' + q.maxLength;
      onInput(q.id, ta.value, true);
    };
    return wrap;
  }

  function renderBoolean(q, rt, onInput) {
    var fake = Object.create(q);
    fake.choices = [
      { value: q.trueText || 'Sí', text: q.trueText || 'Sí' },
      { value: q.falseText || 'No', text: q.falseText || 'No' }
    ];
    fake.hasOther = false;
    return renderChoices(fake, rt, onInput, false);
  }

  // ------------------------------------------------------------ tipos nuevos

  /** Matriz: una fila por aspecto, una columna por nivel de la escala. */
  function renderMatrix(q, rt, onInput) {
    var actual = rt.getValue(q.id) || {};
    var wrap = el('div', 'sbq-matrix-wrap');
    var tabla = el('table', 'sbq-matrix');

    var thead = global.document.createElement('thead');
    var trh = global.document.createElement('tr');
    trh.appendChild(el('th', 'sbq-matrix-corner', ''));
    (q.columns || []).forEach(function (c) {
      trh.appendChild(el('th', null, esc(rt.t(c.text))));
    });
    thead.appendChild(trh);
    tabla.appendChild(thead);

    var tbody = global.document.createElement('tbody');
    (q.rows || []).forEach(function (fila) {
      var tr = global.document.createElement('tr');
      var sinResponder = q.eachRowRequired && rt.showErrors && actual[fila.value] === undefined;
      if (sinResponder) tr.className = 'is-missing';
      tr.appendChild(el('th', 'sbq-matrix-row', esc(rt.t(fila.text))));

      (q.columns || []).forEach(function (col) {
        var td = global.document.createElement('td');
        var marcado = actual[fila.value] === col.value;
        var lbl = el('label', 'sbq-matrix-cell' + (marcado ? ' is-selected' : ''));
        // El nombre de la columna se repite en móvil, donde la cabecera
        // queda lejos de la celda.
        lbl.setAttribute('data-col', rt.t(col.text));

        var input = global.document.createElement('input');
        input.type = 'radio';
        input.name = 'm_' + q.id + '_' + fila.value;
        input.checked = marcado;
        input.onchange = function () { rt.setMatrixCell(q, fila.value, col.value); onInput(q.id, rt.getValue(q.id)); };

        lbl.appendChild(input);
        lbl.appendChild(el('span', 'sbq-matrix-dot', ''));
        td.appendChild(lbl);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    tabla.appendChild(tbody);
    wrap.appendChild(tabla);
    return wrap;
  }

  /** Ordenamiento por preferencia, con arrastre y botones de respaldo. */
  function renderRanking(q, rt, onInput) {
    var orden = rt.rankOrder(q);
    var wrap = el('div', 'sbq-rank');
    var arrastrando = null;

    orden.forEach(function (val, i) {
      var c = (q.choices || []).filter(function (x) { return x.value === val; })[0];
      var fila = el('div', 'sbq-rank-item');
      fila.draggable = true;

      fila.appendChild(el('span', 'sbq-rank-num', String(i + 1)));
      fila.appendChild(el('span', 'sbq-rank-txt', esc(c ? rt.t(c.text) : val)));

      var ctrl = el('div', 'sbq-rank-ctrl');
      var arriba = el('button', 'sbq-icon-btn', '▲');
      arriba.type = 'button';
      arriba.title = 'Subir';
      arriba.disabled = i === 0;
      arriba.onclick = function () { rt.moveRankItem(q, i, i - 1); onInput(q.id, rt.getValue(q.id)); };
      var abajo = el('button', 'sbq-icon-btn', '▼');
      abajo.type = 'button';
      abajo.title = 'Bajar';
      abajo.disabled = i === orden.length - 1;
      abajo.onclick = function () { rt.moveRankItem(q, i, i + 1); onInput(q.id, rt.getValue(q.id)); };
      ctrl.appendChild(arriba); ctrl.appendChild(abajo);
      fila.appendChild(ctrl);

      fila.ondragstart = function () { arrastrando = i; fila.classList.add('is-dragging'); };
      fila.ondragend = function () { fila.classList.remove('is-dragging'); };
      fila.ondragover = function (e) { e.preventDefault(); fila.classList.add('is-over'); };
      fila.ondragleave = function () { fila.classList.remove('is-over'); };
      fila.ondrop = function (e) {
        e.preventDefault();
        fila.classList.remove('is-over');
        if (arrastrando === null || arrastrando === i) return;
        rt.moveRankItem(q, arrastrando, i);
        arrastrando = null;
        onInput(q.id, rt.getValue(q.id));
      };

      wrap.appendChild(fila);
    });
    return wrap;
  }

  /** Selección múltiple compacta: fichas que se agregan y se quitan. */
  function renderTagbox(q, rt, onInput) {
    var sel = rt.getValue(q.id) || [];
    var wrap = el('div');

    if (sel.length) {
      var fichas = el('div', 'sbq-tags');
      sel.forEach(function (val) {
        var c = (q.choices || []).filter(function (x) { return x.value === val; })[0];
        var texto = val === SBQ.Runtime.OTHER
          ? (rt.getValue(q.id + '_otro') || rt.t(q.otherText) || 'Otro')
          : (c ? rt.t(c.text) : val);
        var ficha = el('span', 'sbq-tag', esc(texto));
        var x = el('button', 'sbq-tag-x', '×');
        x.type = 'button';
        x.setAttribute('aria-label', 'Quitar ' + texto);
        x.onclick = function () { rt.toggleChoice(q, val, false); onInput(q.id, rt.getValue(q.id)); };
        ficha.appendChild(x);
        fichas.appendChild(ficha);
      });
      wrap.appendChild(fichas);
    }

    var disponibles = rt.choicesFor(q).filter(function (c) { return sel.indexOf(c.value) < 0; });
    if (disponibles.length) {
      var s = global.document.createElement('select');
      s.className = 'sbq-select';
      var ph = global.document.createElement('option');
      ph.value = '';
      ph.textContent = rt.t(q.placeholder) || 'Agregar…';
      s.appendChild(ph);
      disponibles.forEach(function (c) {
        var o = global.document.createElement('option');
        o.value = String(c.value);
        o.textContent = rt.t(c.text);
        s.appendChild(o);
      });
      s.onchange = function () {
        if (!s.value) return;
        rt.toggleChoice(q, s.value, true);
        onInput(q.id, rt.getValue(q.id));
      };
      wrap.appendChild(s);
    }

    if (sel.indexOf(SBQ.Runtime.OTHER) >= 0) {
      var otro = global.document.createElement('input');
      otro.type = 'text';
      otro.className = 'sbq-input';
      otro.style.marginTop = '8px';
      otro.placeholder = rt.t(q.otherPlaceholder) || 'Cuéntanos brevemente';
      otro.value = rt.getValue(q.id + '_otro') || '';
      otro.oninput = function () { onInput(q.id + '_otro', otro.value, true); };
      wrap.appendChild(otro);
    }
    return wrap;
  }

  /** Varios campos cortos bajo un mismo enunciado. */
  function renderMultipleText(q, rt, onInput) {
    var v = rt.getValue(q.id) || {};
    var wrap = el('div', 'sbq-multitext');
    (q.items || []).forEach(function (item) {
      var campo = el('div', 'sbq-multitext-item');
      campo.appendChild(el('label', null, esc(rt.t(item.title))));
      var i = global.document.createElement('input');
      i.type = item.inputType || 'text';
      i.className = 'sbq-input';
      i.placeholder = rt.t(item.placeholder) || '';
      i.value = v[item.name] || '';
      i.oninput = function () { rt.setTextItem(q, item.name, i.value); onInput(q.id, rt.getValue(q.id), true); };
      campo.appendChild(i);
      wrap.appendChild(campo);
    });
    return wrap;
  }

  /** Elegir por imagen. */
  function renderImagePicker(q, rt, onInput) {
    var actual = rt.getValue(q.id);
    var multiple = !!q.multiSelect;
    var sel = Array.isArray(actual) ? actual : (actual !== undefined ? [actual] : []);
    var wrap = el('div', 'sbq-imgpick');

    (q.choices || []).forEach(function (c) {
      var marcado = sel.indexOf(c.value) >= 0;
      var b = el('button', 'sbq-imgpick-item' + (marcado ? ' is-selected' : ''));
      b.type = 'button';
      b.setAttribute('aria-pressed', marcado ? 'true' : 'false');

      if (c.imageLink) {
        var img = global.document.createElement('img');
        img.src = c.imageLink;
        img.alt = rt.t(c.text) || '';
        img.loading = 'lazy';
        b.appendChild(img);
      } else if (c.emoji) {
        b.appendChild(el('span', 'sbq-imgpick-emoji', esc(c.emoji)));
      }
      if (!q.hideLabels) b.appendChild(el('span', 'sbq-imgpick-txt', esc(rt.t(c.text))));

      b.onclick = function () {
        if (multiple) { rt.toggleChoice(q, c.value, !marcado); onInput(q.id, rt.getValue(q.id)); }
        else onInput(q.id, marcado ? undefined : c.value);
      };
      wrap.appendChild(b);
    });
    return wrap;
  }

  /**
   * Adjuntar archivos. Se guardan como data URI dentro de la respuesta:
   * sin servidor de archivos, es la única forma de que la foto viaje con
   * el resto. Por eso el límite de tamaño es estricto.
   */
  function renderFile(q, rt, onInput) {
    var archivos = rt.getValue(q.id) || [];
    var wrap = el('div', 'sbq-file');

    if (archivos.length) {
      var lista = el('div', 'sbq-file-list');
      archivos.forEach(function (f, i) {
        var fila = el('div', 'sbq-file-item');
        if (f.dataUrl && /^image\//.test(f.type || '')) {
          var img = global.document.createElement('img');
          img.src = f.dataUrl;
          img.alt = f.name;
          fila.appendChild(img);
        } else {
          fila.appendChild(el('span', 'sbq-file-icon', '📎'));
        }
        fila.appendChild(el('span', 'sbq-file-name', esc(f.name)));
        var x = el('button', 'sbq-icon-btn is-danger', '✕');
        x.type = 'button';
        x.setAttribute('aria-label', 'Quitar ' + f.name);
        x.onclick = function () {
          var copia = archivos.slice();
          copia.splice(i, 1);
          onInput(q.id, copia.length ? copia : undefined);
        };
        fila.appendChild(x);
        lista.appendChild(fila);
      });
      wrap.appendChild(lista);
    }

    if (archivos.length < (q.maxFiles || 3)) {
      var lbl = el('label', 'sbq-file-add');
      lbl.appendChild(el('span', null, '📷 ' + (esc(rt.t(q.addFileText)) || 'Agregar foto')));
      var input = global.document.createElement('input');
      input.type = 'file';
      input.accept = q.accept || 'image/*';
      input.hidden = true;
      input.onchange = function () {
        var f = input.files && input.files[0];
        if (!f) return;
        var maxBytes = (q.maxSizeMB || 5) * 1024 * 1024;
        if (f.size > maxBytes) {
          global.alert('El archivo pesa ' + (f.size / 1048576).toFixed(1) +
                       ' MB y el máximo es ' + q.maxSizeMB + ' MB.');
          input.value = '';
          return;
        }
        var lector = new global.FileReader();
        lector.onload = function () {
          onInput(q.id, archivos.concat([{
            name: f.name, type: f.type, size: f.size, dataUrl: lector.result
          }]));
        };
        lector.readAsDataURL(f);
      };
      lbl.appendChild(input);
      wrap.appendChild(lbl);
      wrap.appendChild(el('div', 'sbq-muted',
        'Hasta ' + (q.maxFiles || 3) + ' archivo(s) de ' + (q.maxSizeMB || 5) + ' MB.'));
    }
    return wrap;
  }

  /** Firma sobre un lienzo, con soporte táctil. */
  function renderSignature(q, rt, onInput) {
    var wrap = el('div', 'sbq-sign');
    var lienzo = global.document.createElement('canvas');
    lienzo.className = 'sbq-sign-canvas';
    lienzo.width = q.width || 600;
    lienzo.height = q.height || 200;
    var ctx = lienzo.getContext('2d');
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = q.penColor || '#16181d';

    var previo = rt.getValue(q.id);
    if (previo) {
      var img = new global.Image();
      img.onload = function () { ctx.drawImage(img, 0, 0); };
      img.src = previo;
    }

    var dibujando = false;
    function punto(e) {
      var r = lienzo.getBoundingClientRect();
      var t = e.touches ? e.touches[0] : e;
      return {
        x: (t.clientX - r.left) * (lienzo.width / r.width),
        y: (t.clientY - r.top) * (lienzo.height / r.height)
      };
    }
    function inicio(e) { e.preventDefault(); dibujando = true; var p = punto(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); }
    function mover(e) { if (!dibujando) return; e.preventDefault(); var p = punto(e); ctx.lineTo(p.x, p.y); ctx.stroke(); }
    function fin() {
      if (!dibujando) return;
      dibujando = false;
      onInput(q.id, lienzo.toDataURL('image/png'), true);
    }
    lienzo.addEventListener('mousedown', inicio);
    lienzo.addEventListener('mousemove', mover);
    global.addEventListener('mouseup', fin);
    lienzo.addEventListener('touchstart', inicio, { passive: false });
    lienzo.addEventListener('touchmove', mover, { passive: false });
    lienzo.addEventListener('touchend', fin);

    wrap.appendChild(lienzo);
    var borrar = el('button', 'sbq-btn sbq-btn-sm', 'Borrar firma');
    borrar.type = 'button';
    borrar.onclick = function () {
      ctx.clearRect(0, 0, lienzo.width, lienzo.height);
      onInput(q.id, undefined);
    };
    wrap.appendChild(borrar);
    return wrap;
  }

  /** Grupo repetible: tantas copias del molde como entradas haya. */
  function renderPanelDynamic(q, rt, onInput, opts) {
    var wrap = el('div', 'sbq-pdyn');
    var entradas = rt.panelEntries(q);

    entradas.forEach(function (entrada, i) {
      var caja = el('div', 'sbq-pdyn-item');

      var cab = el('div', 'sbq-pdyn-cab');
      cab.appendChild(el('span', 'sbq-pdyn-tit',
        esc(String(rt.t(q.panelTitle) || 'Elemento {n}').replace('{n}', i + 1))));

      if (!rt.readOnly && entradas.length > (q.minPanels || 0)) {
        var quitar = el('button', 'sbq-btn sbq-btn-sm sbq-btn-danger', esc(rt.t(q.removeText)));
        quitar.type = 'button';
        quitar.onclick = function () { rt.removePanel(q, i); onInput(q.id, rt.getValue(q.id)); };
        cab.appendChild(el('span', 'sbq-spacer'));
        cab.appendChild(quitar);
      }
      caja.appendChild(cab);

      (q.templateElements || []).forEach(function (inner) {
        if (!rt.isEntryQuestionVisible(q, inner, i)) return;

        /* Cada entrada se dibuja con un runtime prestado que apunta a sus
           propios valores. Así se reutiliza todo el renderizador sin duplicar
           una versión "dentro de un repetible" de cada tipo de pregunta. */
        var sub = Object.create(rt);
        sub.values = rt.entryValues(q, i);
        sub.errors = {};
        sub.setValue = function (id, valor) { rt.setEntryValue(q, i, id, valor); };
        sub.toggleChoice = function (qq, valor, marcado) {
          var actual = sub.values[qq.id];
          var lista = Array.isArray(actual) ? actual.slice() : (actual ? [actual] : []);
          if (marcado) { if (lista.indexOf(valor) < 0) lista.push(valor); }
          else lista = lista.filter(function (x) { return x !== valor; });
          rt.setEntryValue(q, i, qq.id, lista);
        };
        sub.getValue = function (id) { return sub.values[id]; };

        caja.appendChild(renderQuestion(inner, sub, function (id, valor, sinRedibujar) {
          rt.setEntryValue(q, i, id, valor);
          onInput(q.id, rt.getValue(q.id), sinRedibujar);
        }, opts));
      });

      wrap.appendChild(caja);
    });

    if (!rt.readOnly && entradas.length < (q.maxPanels || 99)) {
      var agregar = el('button', 'sbq-btn sbq-pdyn-add', esc(rt.t(q.addText)));
      agregar.type = 'button';
      agregar.onclick = function () { rt.addPanel(q); onInput(q.id, rt.getValue(q.id)); };
      wrap.appendChild(agregar);
    }
    return wrap;
  }

  // -------------------------------------------------------------- pregunta -

  /**
   * Dibuja una pregunta completa (enunciado, control y error).
   * @param {object} q pregunta normalizada
   * @param {Runtime} rt runtime activo
   * @param {function} onInput (id, valor, sinRedibujar) -> void
   * @param {object} opts { showFlags:boolean }
   */
  function renderQuestion(q, rt, onInput, opts) {
    opts = opts || {};
    var error = rt.showErrors ? rt.errors[q.id] : null;
    var node = el('div', 'sbq-q' + (error ? ' has-error' : ''));
    node.dataset.questionId = q.id;

    if (q.type === 'html') {
      node.appendChild(el('div', null, rt.t(q.html) || ''));
      return node;
    }

    // Grupo: se dibuja como un bloque con sus preguntas dentro.
    if (q.type === 'panel') {
      node.className = 'sbq-panel-q';
      if (q.title) node.appendChild(el('div', 'sbq-panel-q-title', esc(rt.t(q.title))));
      if (q.description) node.appendChild(el('div', 'sbq-q-desc', esc(rt.t(q.description))));
      var cuerpo = el('div', 'sbq-panel-q-body');
      rt.visibleElements(q).forEach(function (hijo) {
        cuerpo.appendChild(renderQuestion(hijo, rt, onInput, opts));
      });
      node.appendChild(cuerpo);
      return node;
    }

    // Valor calculado: se muestra, no se pregunta.
    if (q.type === 'expression') {
      if (q.hideIfEmpty && rt.getValue(q.id) === undefined) {
        node.className += ' sbq-hidden';
        return node;
      }
      node.className += ' sbq-expression';
      if (q.title) node.appendChild(el('div', 'sbq-q-title', esc(rt.t(q.title))));
      var val = rt.getValue(q.id);
      node.appendChild(el('div', 'sbq-expression-val',
        esc(val === undefined || val === null ? '—' : String(val))));
      return node;
    }

    var title = el('div', 'sbq-q-title');
    title.innerHTML = esc(rt.t(q.title) || '(sin enunciado)');
    if (rt.isQuestionRequired(q)) title.appendChild(el('span', 'sbq-q-req', '*'));
    if (opts.showFlags && q.reconstruido) title.appendChild(el('span', 'sbq-flag', 'reconstruido'));
    if (opts.showFlags && q.revisar) title.appendChild(el('span', 'sbq-flag', 'por validar'));
    node.appendChild(title);

    if (q.description) {
      node.appendChild(el('div', 'sbq-q-desc', esc(rt.t(q.description))));
    }

    var body = el('div', 'sbq-q-body');
    var control;
    switch (q.type) {
      case 'rating':   control = renderRating(q, rt, onInput); break;
      case 'radio':    control = renderChoices(q, rt, onInput, false); break;
      case 'checkbox': control = renderChoices(q, rt, onInput, true); break;
      case 'dropdown': control = renderDropdown(q, rt, onInput); break;
      case 'text':     control = renderText(q, rt, onInput); break;
      case 'comment':  control = renderComment(q, rt, onInput); break;
      case 'boolean':  control = renderBoolean(q, rt, onInput); break;
      case 'tagbox':      control = renderTagbox(q, rt, onInput); break;
      case 'matrix':      control = renderMatrix(q, rt, onInput); break;
      case 'ranking':     control = renderRanking(q, rt, onInput); break;
      case 'multipletext':control = renderMultipleText(q, rt, onInput); break;
      case 'imagepicker': control = renderImagePicker(q, rt, onInput); break;
      case 'file':        control = renderFile(q, rt, onInput); break;
      case 'signature':   control = renderSignature(q, rt, onInput); break;
      case 'paneldynamic':control = renderPanelDynamic(q, rt, onInput, opts); break;
      default:         control = el('div', 'sbq-muted', 'Tipo no soportado: ' + esc(q.type));
    }

    if (rt.readOnly) {
      // Un contenedor inerte: se ve igual, no se puede tocar y no confunde a
      // quien lo lee creyendo que puede corregir.
      control.classList.add('es-lectura');
      control.setAttribute('aria-readonly', 'true');
      Array.prototype.forEach.call(
        control.querySelectorAll('input, textarea, select, button'),
        function (c) { c.disabled = true; });
    } else if (!rt.isQuestionEnabled(q)) {
      control.style.opacity = '.5';
      control.style.pointerEvents = 'none';
    }

    body.appendChild(control);
    node.appendChild(body);

    if (error) node.appendChild(el('div', 'sbq-error', '<span>⚠</span><span>' + esc(error) + '</span>'));

    return node;
  }

  /** Dibuja una página completa. */
  function renderPage(page, rt, onInput, opts) {
    var wrap = el('div', 'sbq-card');
    if (page.title) wrap.appendChild(el('h2', 'sbq-page-title', esc(rt.t(page.title))));
    if (page.description) wrap.appendChild(el('p', 'sbq-page-desc', esc(rt.t(page.description))));

    // Elementos directos: los paneles se dibujan a sí mismos con sus hijos.
    var qs = rt.visibleElements(page);
    if (!qs.length) {
      wrap.appendChild(el('div', 'sbq-empty', 'Esta página no tiene preguntas visibles.'));
    }
    qs.forEach(function (q) { wrap.appendChild(renderQuestion(q, rt, onInput, opts)); });
    return wrap;
  }

  SBQ.render = {
    el: el,
    question: renderQuestion,
    page: renderPage,
    EMOJI_5: EMOJI_5
  };

})(typeof window !== 'undefined' ? window : globalThis);
