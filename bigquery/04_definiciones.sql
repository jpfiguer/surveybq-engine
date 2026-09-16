-- surveyBQ · definiciones de encuesta publicadas desde el editor.
--
-- Cada publicación agrega una fila nueva; nunca se sobrescribe. Así queda el
-- historial completo de qué se preguntó en cada momento, que es lo que
-- permite interpretar respuestas viejas cuando la encuesta ya cambió.
--
-- El respondedor lee la última versión de cada encuesta; si no hay ninguna,
-- usa la que viene en el archivo desplegado.

CREATE TABLE IF NOT EXISTS `proyecto.experiencia_clientes.survey_definitions`
(
  survey_id    STRING NOT NULL OPTIONS (description = 'demo-tipos | nps-relacional | ...'),
  version      STRING          OPTIONS (description = 'Versión declarada en la encuesta.'),
  titulo       STRING          OPTIONS (description = 'Título al momento de publicar.'),
  definicion   STRING NOT NULL OPTIONS (description = 'La encuesta completa en JSON.'),
  publicado_en TIMESTAMP NOT NULL OPTIONS (description = 'Marca de tiempo del servidor.'),
  publicado_por STRING         OPTIONS (description = 'Nota libre de quién publicó.'),
  notas        STRING          OPTIONS (description = 'Qué se cambió, escrito por quien publica.')
)
PARTITION BY DATE(publicado_en)
CLUSTER BY survey_id
OPTIONS (description = 'Historial de versiones publicadas desde el editor web.');
