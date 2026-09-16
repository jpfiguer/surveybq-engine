/*!
 * surveyBQ — theme.js
 * Apariencia por encuesta. Se guarda en `survey.theme` y se aplica escribiendo
 * las variables CSS sobre un elemento, así que no hay hojas de estilo por tema
 * ni clases que se peleen entre sí.
 */
(function (global) {
  'use strict';

  var SBQ = global.SBQ || (global.SBQ = {});

  /** Ajustes disponibles, con su variable CSS y valor por defecto. */
  var CAMPOS = [
    { id: 'accent',      var: '--accent',      tipo: 'color',  etiqueta: 'Color principal',    def: '#1f5fd6' },
    { id: 'accentText',  var: '--accent-text', tipo: 'color',  etiqueta: 'Texto sobre el color', def: '#ffffff' },
    { id: 'bg',          var: '--bg',          tipo: 'color',  etiqueta: 'Fondo',              def: '' },
    { id: 'surface',     var: '--surface',     tipo: 'color',  etiqueta: 'Tarjetas',           def: '' },
    { id: 'text',        var: '--text',        tipo: 'color',  etiqueta: 'Texto',              def: '' },
    { id: 'radius',      var: '--radius',      tipo: 'medida', etiqueta: 'Redondeo',           def: '12px' },
    { id: 'font',        var: '--font',        tipo: 'texto',  etiqueta: 'Tipografía',         def: '' },
    { id: 'maxw',        var: '--maxw',        tipo: 'medida', etiqueta: 'Ancho máximo',       def: '720px' }
  ];

  /** Combinaciones listas, para no partir de cero. */
  var PRESETS = {
    'Be Quarks': { accent: '#b4124f', radius: '16px' },   /* magenta de marca */
    'Púrpura':   { accent: '#7a1486', radius: '16px' },   /* secondary de marca */
    'Petróleo':  { accent: '#0b5c57', radius: '12px' },
    'Vino':      { accent: '#7e0d37', radius: '10px' },
    'Grafito':   { accent: '#1c252e', radius: '8px' },
    'Naranjo':   { accent: '#c2410c', radius: '14px' }
  };

  /**
   * Escribe las variables del tema sobre un elemento.
   * Las que estén vacías se quitan, para que vuelva a mandar la hoja base y
   * el modo oscuro siga funcionando.
   */
  function apply(theme, elemento) {
    var destino = elemento || global.document.documentElement;
    CAMPOS.forEach(function (c) {
      var v = theme ? theme[c.id] : null;
      if (v) destino.style.setProperty(c.var, v);
      else destino.style.removeProperty(c.var);
    });

    // El acento tiene un tono suave derivado que se usa en fondos.
    if (theme && theme.accent) {
      destino.style.setProperty('--accent-soft',
        'color-mix(in srgb, ' + theme.accent + ' 12%, transparent)');
    } else {
      destino.style.removeProperty('--accent-soft');
    }
  }

  SBQ.theme = { CAMPOS: CAMPOS, PRESETS: PRESETS, apply: apply };

})(typeof window !== 'undefined' ? window : globalThis);
