/*!
 * surveyBQ — Demostración de tipos de pregunta
 *
 * No es una encuesta de producción: existe para probar y mostrar todo lo que
 * el motor sabe hacer. Sirve de referencia al construir encuestas nuevas y
 * como banco de pruebas cuando se toca el renderizador.
 *
 * Está en dos idiomas para ejercitar la localización.
 */
SBQ.registerSurvey({
  id: 'demo-tipos',
  version: '1.0.0',
  title: 'Demostración de tipos de pregunta',
  description: 'Todos los tipos que soporta el motor, en un solo recorrido.',
  locale: 'es',

  settings: {
    showProgress: true,
    requiredByDefault: false,
    onTimeUp: 'nextPage',
    scored: true,
    passingScore: 2,
    thankYou: {
      title: { es: '¡Listo!', en: 'All done!' },
      text: {
        es: 'Recorriste todos los tipos de pregunta del motor.',
        en: 'You went through every question type the engine supports.'
      }
    }
  },

  variables: { producto: 'surveyBQ' },

  /* Regla que se dispara al avanzar, no al responder. */
  triggers: [
    { runIf: '{satisfaccion} <= 2', setValue: { id: 'necesita_seguimiento', value: 'sí' } }
  ],

  computed: [
    { id: 'aspectos_marcados', label: 'Cantidad de aspectos elegidos', coalesce: ['aspectos'] }
  ],

  pages: [
    {
      id: 'escalas',
      title: { es: 'Escalas', en: 'Rating scales' },
      /* Límite generoso: la demo se recorre sin apuro, pero deja ver el reloj
         y probar qué pasa al agotarse. */
      timeLimit: 300,
      description: { es: 'Las tres métricas de experiencia.', en: 'The three experience metrics.' },
      elements: [
        {
          id: 'satisfaccion', type: 'rating', role: 'score', required: true,
          title: { es: '¿Qué tan satisfecho quedaste?', en: 'How satisfied were you?' },
          rateMin: 1, rateMax: 5, displayMode: 'emoji',
          minLabel: { es: 'Muy insatisfecho', en: 'Very unsatisfied' },
          maxLabel: { es: 'Muy satisfecho', en: 'Very satisfied' }
        },
        {
          id: 'recomendacion', type: 'rating',
          title: { es: '¿Qué tan probable es que lo recomiendes?', en: 'How likely are you to recommend it?' },
          rateMin: 0, rateMax: 10, colorScale: 'nps',
          minLabel: { es: 'Nada probable', en: 'Not at all likely' },
          maxLabel: { es: 'Muy probable', en: 'Extremely likely' }
        },
        {
          /* CES: la tercera métrica que aparece en la plantilla de Qualtrics. */
          id: 'esfuerzo', type: 'rating', role: 'score',
          title: { es: '¿Cuánto esfuerzo te costó resolverlo?', en: 'How much effort did it take?' },
          rateMin: 1, rateMax: 7,
          minLabel: { es: 'Muy poco', en: 'Very little' },
          maxLabel: { es: 'Muchísimo', en: 'A great deal' }
        },
        {
          id: 'nota_100', type: 'expression',
          title: { es: 'Tu satisfacción sobre 100', en: 'Your satisfaction out of 100' },
          expression: 'round({satisfaccion} * 20)',
          hideIfEmpty: true
        }
      ]
    },

    {
      id: 'alternativas',
      title: { es: 'Alternativas', en: 'Choices' },
      elements: [
        {
          id: 'canal_preferido', type: 'radio',
          title: { es: '¿Por dónde prefieres respondernos?', en: 'How do you prefer to answer us?' },
          choices: [
            { value: 'qr', text: { es: 'Código QR en el local', en: 'QR code on site' } },
            { value: 'email', text: { es: 'Correo electrónico', en: 'Email' } },
            { value: 'wsp', text: { es: 'WhatsApp', en: 'WhatsApp' } }
          ],
          hasOther: true,
          otherText: { es: 'Otro, ¿cuál?', en: 'Other, which one?' }
        },
        {
          id: 'aspectos', type: 'checkbox',
          title: { es: '¿Qué aspectos te importan? (varias)', en: 'Which aspects matter to you? (several)' },
          minSelect: 1, maxSelect: 3,
          description: { es: 'Elige entre 1 y 3.', en: 'Pick between 1 and 3.' },
          choices: ['Limpieza', 'Seguridad', 'Precios', 'Atención', 'Variedad'],
          hasOther: true
        },
        {
          id: 'marcas', type: 'tagbox',
          title: { es: '¿Qué marcas echas de menos?', en: 'Which brands do you miss?' },
          placeholder: { es: 'Agregar marca…', en: 'Add a brand…' },
          choices: ['Zara', 'H&M', 'Under Armour', 'Falabella', 'Decathlon'],
          hasOther: true
        },
        {
          id: 'cara', type: 'imagepicker',
          title: { es: '¿Cómo te fuiste?', en: 'How did you leave?' },
          choices: [
            { value: 'mal', text: { es: 'Molesto', en: 'Annoyed' }, emoji: '😠' },
            { value: 'neutro', text: { es: 'Indiferente', en: 'Indifferent' }, emoji: '😐' },
            { value: 'bien', text: { es: 'Contento', en: 'Happy' }, emoji: '😄' }
          ]
        }
      ]
    },

    {
      id: 'matriz',
      title: { es: 'Matriz y orden', en: 'Matrix and ranking' },
      elements: [
        {
          id: 'evaluacion', type: 'matrix', role: 'score',
          title: { es: 'Evalúa cada aspecto', en: 'Rate each aspect' },
          eachRowRequired: true,
          rows: [
            { value: 'limpieza', text: { es: 'Limpieza', en: 'Cleanliness' } },
            { value: 'rapidez', text: { es: 'Rapidez', en: 'Speed' } },
            { value: 'amabilidad', text: { es: 'Amabilidad', en: 'Friendliness' } }
          ],
          columns: [
            { value: 1, text: { es: 'Malo', en: 'Poor' } },
            { value: 2, text: { es: 'Regular', en: 'Fair' } },
            { value: 3, text: { es: 'Bueno', en: 'Good' } },
            { value: 4, text: { es: 'Excelente', en: 'Excellent' } }
          ]
        },
        {
          id: 'prioridades', type: 'ranking',
          title: { es: 'Ordena según lo que más te importa', en: 'Rank by what matters most' },
          description: { es: 'Arrastra o usa las flechas.', en: 'Drag or use the arrows.' },
          choices: [
            { value: 'precio', text: { es: 'Precio', en: 'Price' } },
            { value: 'cercania', text: { es: 'Cercanía', en: 'Proximity' } },
            { value: 'variedad', text: { es: 'Variedad', en: 'Variety' } },
            { value: 'ambiente', text: { es: 'Ambiente', en: 'Atmosphere' } }
          ]
        }
      ]
    },

    {
      id: 'detalle',
      title: { es: 'Detalle', en: 'Details' },
      elements: [
        {
          /* Grupo condicional: solo aparece si la nota fue baja. */
          id: 'grupo_queja', type: 'panel',
          title: { es: 'Cuéntanos qué pasó', en: 'Tell us what happened' },
          description: { es: 'Aparece solo con nota 1 o 2.', en: 'Only shows for a score of 1 or 2.' },
          visibleIf: '{satisfaccion} <= 2',
          elements: [
            {
              id: 'que_paso', type: 'comment', role: 'verbatim',
              title: { es: '¿Qué ocurrió?', en: 'What happened?' },
              rows: 3, maxLength: 500
            },
            {
              id: 'evidencia', type: 'file',
              title: { es: '¿Tienes una foto?', en: 'Do you have a photo?' },
              description: { es: 'Opcional, ayuda mucho a operaciones.', en: 'Optional, it helps operations a lot.' },
              maxFiles: 2, maxSizeMB: 5
            }
          ]
        },
        {
          id: 'contacto', type: 'multipletext',
          title: { es: 'Si quieres que te contactemos', en: 'If you want us to reach out' },
          items: [
            { name: 'nombre', title: { es: 'Nombre', en: 'Name' } },
            { name: 'email', title: { es: 'Correo', en: 'Email' }, inputType: 'email' }
          ]
        },
        {
          id: 'edad', type: 'text', inputType: 'number',
          title: { es: 'Tu edad', en: 'Your age' },
          min: 14, max: 110
        },
        {
          id: 'rut', type: 'text',
          title: { es: 'RUT (opcional)', en: 'National ID (optional)' },
          placeholder: '12.345.678-9',
          pattern: '^[0-9]{1,2}\\.?[0-9]{3}\\.?[0-9]{3}-[0-9kK]$',
          patternMessage: { es: 'Formato: 12.345.678-9', en: 'Format: 12.345.678-9' }
        }
      ]
    },

    {
      id: 'repetible',
      title: { es: 'Grupo repetible', en: 'Repeating group' },
      description: {
        es: 'Se agregan tantos como haga falta.',
        en: 'Add as many as needed.'
      },
      elements: [
        {
          id: 'locales', type: 'paneldynamic',
          title: { es: '¿Qué locales visitaste hoy?', en: 'Which stores did you visit today?' },
          panelTitle: { es: 'Local {n}', en: 'Store {n}' },
          addText: { es: '+ Agregar otro local', en: '+ Add another store' },
          removeText: { es: 'Quitar', en: 'Remove' },
          minPanels: 1, maxPanels: 4,
          templateElements: [
            {
              id: 'nombre', type: 'text', required: true,
              title: { es: 'Nombre del local', en: 'Store name' },
              placeholder: 'Zara'
            },
            {
              id: 'nota', type: 'rating',
              title: { es: '¿Qué tal la atención?', en: 'How was the service?' },
              rateMin: 1, rateMax: 5, displayMode: 'emoji'
            },
            {
              /* {panel.nota} apunta a la nota de ESTA entrada, no a otra. */
              id: 'motivo', type: 'comment', rows: 2,
              title: { es: '¿Qué pasó?', en: 'What happened?' },
              visibleIf: '{panel.nota} <= 2'
            }
          ]
        }
      ]
    },

    {
      id: 'cierre',
      title: { es: 'Cierre', en: 'Wrap-up' },
      elements: [
        {
          id: 'conforme', type: 'boolean',
          title: { es: '¿Autorizas que usemos tu respuesta?', en: 'Do you allow us to use your answer?' }
        },
        {
          id: 'firma', type: 'signature',
          title: { es: 'Firma', en: 'Signature' },
          visibleIf: "{conforme} = 'Sí'",
          height: 160
        }
      ]
    }
  ]
});
