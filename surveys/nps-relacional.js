/*!
 * surveyBQ — Encuesta Relacional (NPS)
 * Fuente: "Flujo Encuesta Relacional (NPS).xlsx"
 *   · hoja "Flujo encuesta Relacional" (estructura, DCL y criterios de muestra)
 *   · hoja "Flujo Piloto WSP" (secuencia de las 4 preguntas y causas raíz)
 *
 * Ramificación del motivo según la nota, tal como define el DCL:
 *   0,1,2,3,9,10  (Promotores y Hard Detractors) -> "¿Cuál es el principal motivo...?"
 *   4,5,6,7,8     (Pasivos y Soft Detractors)    -> "¿Qué mejorarías...?"
 */

/* Los seis drivers y sus causas raíz. Se declaran una sola vez y se expanden
   más abajo, para que agregar o quitar un driver sea un cambio en un solo lugar. */
var NPS_DRIVERS = [
  {
    slug: 'variedad',
    name: 'Variedad de locales',
    hint: 'tiendas, restaurantes, bancos, etc.',
    causas: ['Variedad de tiendas y marcas', 'Exclusividad de marcas',
             'Variedad de productos y/o servicios', 'Ofertas y precios']
  },
  {
    slug: 'ambiente',
    name: 'Ambiente e instalaciones',
    hint: 'limpieza, música, señalética, etc.',
    causas: ['Espacios para sentarse', 'Señalización', 'Música ambiente',
             'Temperatura', 'Limpieza']
  },
  {
    slug: 'seguridad',
    name: 'Seguridad',
    hint: '',
    causas: ['Seguridad en exteriores', 'Cantidad de guardias', 'Cámaras de vigilancia',
             'Pérdida de pertenencias', 'Seguridad en tiendas', 'Seguridad en estacionamientos']
  },
  {
    slug: 'personal',
    name: 'Atención y servicio del personal',
    hint: '',
    causas: ['Personal de tiendas', 'Personal de restaurantes', 'Personal de seguridad',
             'Personal de limpieza', 'Personal de estacionamientos',
             'Personal módulo de informaciones',
             'Atención del personal del call center o redes sociales']
  },
  {
    slug: 'accesos',
    name: 'Conectividad y accesos',
    hint: 'ingreso y salida',
    causas: ['Facilidad para llegar', 'Señalización de ingreso y salida',
             'Señalización al interior de los estacionamientos',
             'Disponibilidad de estacionamientos', 'Organización de los estacionamientos']
  },
  {
    slug: 'servicios',
    name: 'Servicios',
    hint: 'wifi, sala de lactancia, coches, silla de ruedas, etc.',
    causas: ['Préstamo de sillas de ruedas', 'Préstamo de coches', 'Conexión WIFI',
             'Sala de lactancia']
  }
];

(function () {
  'use strict';

  function driverChoices() {
    return NPS_DRIVERS.map(function (d) {
      return {
        value: d.name,
        text: d.hint ? d.name + ' (' + d.hint + ')' : d.name,
        description: '',
        slug: d.slug
      };
    });
  }

  /* Una pregunta de causa raíz por driver, visible solo cuando ese driver fue
     el elegido (sea cual sea de las dos ramas de motivo). */
  var causaElements = NPS_DRIVERS.map(function (d) {
    return {
      id: 'causa_' + d.slug,
      type: 'radio',
      role: 'root_cause',
      required: true,
      title: '¿Por qué consideras «' + d.name + '» como el principal motivo de tu calificación?',
      visibleIf: "{driver} = '" + d.name + "'",
      choices: d.causas.map(function (c) { return { value: c, text: c }; }),
      hasOther: true,
      otherText: 'Otro, ¿cuál?'
    };
  });

  SBQ.registerSurvey({
    id: 'nps-relacional',
    version: '1.0.0',
    title: 'Encuesta Relacional (NPS)',
    description: 'Nivel de recomendación del centro comercial y sus principales drivers.',
    locale: 'es-CL',
    source: 'Flujo Encuesta Relacional (NPS).xlsx',

    settings: {
      showProgress: true,
      requiredByDefault: false,
      scoreQuestion: 'nps',
      scoreType: 'NPS',
      thankYou: {
        title: '¡Gracias por responder!',
        text: 'Tu opinión alimenta directamente las decisiones sobre el centro comercial.'
      },
      disqualified: {
        title: 'Gracias de todas formas',
        text: 'Esta encuesta está dirigida a quienes nos visitaron en los últimos 6 meses. ¡Te esperamos pronto!'
      }
    },

    variables: { centro_comercial: 'Centro Comercial Demo' },

    /* Columna única de driver, sin importar por cuál de las dos ramas se llegó. */
    computed: [
      { id: 'driver', label: 'Motivo NPS elegido', coalesce: ['driver_alto', 'driver_medio'] },
      { id: 'causa_raiz', label: 'Causa raíz elegida',
        coalesce: NPS_DRIVERS.map(function (d) { return 'causa_' + d.slug; }) }
    ],

    pages: [
      {
        id: 'screener',
        title: 'Antes de empezar',
        /* El DCL exige visita en los últimos 6 meses; si no, la encuesta termina. */
        disqualifyIf: "{visito_6m} = 'No'",
        elements: [
          {
            id: 'screener_intro', type: 'html',
            html: '<p>Queremos saber cómo ha sido tu experiencia con <strong>{centro_comercial}</strong>. Son 4 preguntas.</p>'
          },
          {
            id: 'visito_6m', type: 'radio', role: 'screener', required: true,
            title: '¿Has visitado {centro_comercial} en los últimos 6 meses?',
            choices: ['Sí', 'No']
          }
        ]
      },

      {
        id: 'nps',
        title: 'Tu recomendación',
        elements: [{
          id: 'nps', type: 'rating', role: 'score', required: true,
          title: 'Con base en tu experiencia, ¿qué tan probable es que recomiendes {centro_comercial} a un amigo o familiar?',
          rateMin: 0, rateMax: 10, displayMode: 'numbers',
          minLabel: 'Nada probable', maxLabel: 'Muy probable',
          colorScale: 'nps'
        }]
      },

      {
        id: 'motivo',
        title: 'El principal motivo',
        elements: [
          {
            /* Promotores y Hard Detractors */
            id: 'driver_alto', type: 'radio', role: 'driver', required: true,
            title: '¿Cuál es el principal motivo de haberlo calificado con nota {nps}?',
            description: 'Elige solo una opción.',
            visibleIf: '{nps} anyof [0,1,2,3,9,10]',
            choices: driverChoices(), randomize: true,
            hasOther: true, otherText: 'Otro, ¿cuál?'
          },
          {
            /* Pasivos y Soft Detractors */
            id: 'driver_medio', type: 'radio', role: 'driver', required: true,
            title: '¿Qué mejorarías para calificarlo con una mejor nota?',
            description: 'Elige solo una opción.',
            visibleIf: '{nps} anyof [4,5,6,7,8]',
            choices: driverChoices(), randomize: true,
            hasOther: true, otherText: 'Otro, ¿cuál?'
          }
        ]
      },

      {
        id: 'causa_raiz',
        title: 'Un poco más de detalle',
        visibleIf: '{driver} notempty',
        elements: causaElements
      },

      {
        id: 'wow',
        title: 'Para terminar',
        elements: [{
          id: 'experiencia_wow', type: 'comment', role: 'verbatim', required: true,
          title: 'Finalmente, ¿de qué manera {centro_comercial} podría sorprenderte en tu próxima visita?',
          rows: 4, maxLength: 1000, placeholder: 'Cuéntanos tu idea'
        }]
      }
    ]
  });
})();
