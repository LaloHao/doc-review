// Minimal PDF writer for tests and the local demo: text pages in Helvetica
// (WinAnsi, so Spanish accents work), with automatic line wrapping.
// Usage: node test/fixtures/make-pdf.mjs out.pdf [v2]

import { writeFileSync } from "node:fs";

function pdfString(s) {
  const bytes = Buffer.from(
    s.replace(/[“”«»]/g, '"').replace(/[‘’]/g, "'").replace(/[—–]/g, "-"),
    "latin1",
  );
  let out = "";
  for (const b of bytes) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) out += "\\" + String.fromCharCode(b);
    else if (b < 32 || b > 126) out += "\\" + b.toString(8).padStart(3, "0");
    else out += String.fromCharCode(b);
  }
  return `(${out})`;
}

function wrap(text, width = 80) {
  const lines = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if ((line + " " + word).trim().length > width) {
        lines.push(line);
        line = word;
      } else line = (line + " " + word).trim();
    }
    lines.push(line);
  }
  return lines;
}

/** pages: array of { heading?: string, text: string } → PDF bytes. */
export function makePdf(pages) {
  const objects = [];
  const add = (body) => {
    objects.push(body);
    return objects.length;
  };
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const bold = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  const pagesId = objects.length + 1;
  objects.push(null); // placeholder for /Pages
  const kids = [];
  pages.forEach((p, i) => {
    let content = "BT\n";
    let y = 720;
    if (p.heading) {
      for (const h of p.heading.split("\n")) {
        content += `/F2 18 Tf 1 0 0 1 72 ${y} Tm ${pdfString(h)} Tj\n`;
        y -= 26;
      }
      y -= 10;
    }
    for (const line of wrap(p.text)) {
      content += `/F1 11 Tf 1 0 0 1 72 ${y} Tm ${pdfString(line)} Tj\n`;
      y -= 15;
      if (y < 60) break;
    }
    content += `/F1 9 Tf 1 0 0 1 300 30 Tm (${i + 1}) Tj\nET`;
    const stream = add(`<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`);
    kids.push(
      add(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R /F2 ${bold} 0 R >> >> /Contents ${stream} 0 R >>`,
      ),
    );
  });
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  let out = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}

export const TITLE =
  "Método computacional para la generación trazable de recomendaciones de rutas de transporte público asistida por modelos de aprendizaje automático";

/** A small sample thesis; v2 adds and changes some sentences. */
export function sampleThesis(v2 = false) {
  const intro = [
    "La analítica de datos de viajes se está incorporando con rapidez a la planificación del transporte público.",
    "Esto genera recomendaciones que se despliegan sin una revisión formal suficiente y que empiezan a producir rutas poco eficientes en operación.",
    v2
      ? "Los equipos necesitan un método para documentar esos incidentes de manera trazable y reproducible."
      : "Los equipos necesitan un método para documentar esos incidentes.",
    "Un sistema de recomendación combina datos de viajes, horarios, incidencias y preferencias de los usuarios.",
    "Sin embargo, los datos crudos de viajes no pueden enviarse a un modelo externo por razones de privacidad.",
  ];
  if (v2) intro.push("Por ello se propone anonimizar los datos de viajes antes de entregarlos a un agente local.");
  const marco = [
    "Una ruta de transporte público es una secuencia ordenada de paradas servidas por una o más líneas.",
    "La anonimización consiste en reemplazar datos personales o secretos por marcadores consistentes.",
    "Los modelos de aprendizaje automático permiten procesar información sin que salga de la organización.",
  ];
  const estado = [
    "Se realizó un mapeo sistemático de la literatura sobre sistemas de recomendación de rutas.",
    "Los trabajos revisados se agrupan en tres familias: planificación, predicción y recomendación.",
    v2 ? "Ningún trabajo revisado combina la anonimización con la recomendación de rutas en tiempo real." : "Pocos trabajos combinan ambos aspectos.",
  ];
  return makePdf([
    { heading: "Universidad Nacional de Ejemplo", text: TITLE + "\nEduardo Ejemplo" },
    {
      heading: "Índice general",
      text: "1. Introducción 3\n2. Marco teórico 4\n3. Estado del arte 5",
    },
    { heading: "Capítulo 1\nIntroducción", text: intro.join(" ") },
    { heading: "Capítulo 2\nMarco teórico", text: marco.join(" ") },
    { heading: "Capítulo 3\nEstado del arte", text: estado.join(" ") },
  ]);
}

export function sampleAvance(v2 = false) {
  return {
    schema: 1,
    title: TITLE,
    generated_at: new Date(v2 ? "2026-10-20T18:00:00Z" : "2026-10-10T18:00:00Z").toISOString(),
    total_words: v2 ? 2950 : 2400,
    chapters: [
      { id: "01-introduccion", title: "Introducción", words: v2 ? 1450 : 1100, goal: 3000, status: v2 ? "revision" : "borrador" },
      { id: "02-marco-teorico", title: "Marco teórico", words: 900, goal: 6000, status: "borrador" },
      { id: "03-estado-del-arte", title: "Estado del arte", words: v2 ? 600 : 400, goal: 5000, status: "borrador" },
    ],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [out, which] = process.argv.slice(2);
  if (!out) {
    console.error("usage: node make-pdf.mjs out.pdf [v2]");
    process.exit(2);
  }
  const v2 = which === "v2";
  writeFileSync(out, sampleThesis(v2));
  writeFileSync(out.replace(/\.pdf$/, ".avance.json"), JSON.stringify(sampleAvance(v2), null, 2));
}
