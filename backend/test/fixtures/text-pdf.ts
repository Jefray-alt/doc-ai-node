// Small ASCII-only PDF with a real cross-reference table for storage integration tests.
export function textPdf(): string {
  const content = 'BT /F1 12 Tf 72 720 Td (Floci integration) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.7\n';
  const offsets = objects.map((object, index) => {
    const offset = pdf.length;
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset.toString().padStart(10, '0');
  });
  const xrefOffset = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map((offset) => `${offset} 00000 n \n`).join('')}`;
  return `${pdf}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
}
