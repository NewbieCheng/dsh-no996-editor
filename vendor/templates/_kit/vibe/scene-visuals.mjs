// Geometry is authored by the kit; all user-facing labels are separate DOM
// layers in editable-page.mjs. No user input becomes SVG markup or attributes.
const line = '<path d="M95 313L206 257L312 275L411 194L526 142"/><path d="M497 143L526 142L519 170"/>' +
  [ [95,313], [206,257], [312,275], [411,194] ].map(([x,y]) => `<circle cx="${x}" cy="${y}" r="8" fill="#0b1924"/>`).join('');
const balance = '<path d="M312 130v190m-68 1h136m-224-126 312-57M156 195l-49 85h98Zm312-57-48 85h96Z"/><circle cx="312" cy="169" r="12" fill="#0b1924"/>';
const doors = '<path opacity=".55" d="M146 333V119h122v214M345 333V119h122v214M113 333h387"/><path d="M149 330V121h116v209ZM348 331V121l104-26v250Z"/><circle cx="234" cy="228" r="5"/><circle cx="422" cy="222" r="5"/>';
const slices = Array.from({ length: 6 }, (_, i) => `<rect x="${91 + i * 76}" y="${i === 1 ? 163 : 196}" width="57" height="90" rx="10" fill="${i === 1 ? '#fbd46c' : '#0b1924'}" opacity="${i === 1 ? 1 : 0.42}"/>`).join('');
const runway = '<path d="M102 305H523m-421-92h421m-420 48h420" opacity=".42" stroke-dasharray="9 12"/><path d="M103 260h407l-24-24m24 24-24 24"/><path d="M102 278v-35m134 35v-35m134 35v-35" opacity=".6"/>';
const matrix = Array.from({ length: 96 }, (_, i) => `<rect x="${115 + (i % 12) * 35}" y="${106 + Math.floor(i / 12) * 29}" width="20" height="16" rx="3" opacity="${i % 13 === 0 ? 0.94 : 0.34}" fill="${i % 13 === 0 ? '#fbd46c' : '#132431'}" stroke-width="1.5"/>`).join('');
const closing = '<path opacity=".45" d="M143 212h334M310 86v259" stroke-dasharray="5 10"/><circle cx="310" cy="215" r="105" opacity=".37"/><circle cx="310" cy="215" r="72" opacity=".52"/><circle cx="310" cy="215" r="39"/><path d="M291 217l12 12 25-29"/>';
const motifs = { line, balance, doors, slices, runway, matrix, closing };
const focus = { line: [526, 142], balance: [312, 169], doors: [422, 222], slices: [196, 209], runway: [510, 260], matrix: [510, 317], closing: [310, 215] };

export function vibeDiagram(motif) {
  if (!Object.hasOwn(motifs, motif)) throw new Error('Unknown Vibe visual motif');
  const [x,y] = focus[motif];
  return `<div class="vibe-diagram" data-element-id="vibe-diagram">
      <svg viewBox="0 0 620 450" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <defs><pattern id="vibe-grid" width="36" height="36" patternUnits="userSpaceOnUse"><path d="M36 0H0V36" fill="none" stroke="#223745" stroke-width="1"/></pattern></defs>
        <rect x="18" y="24" width="584" height="400" rx="26" fill="#0b1924" stroke="#324a59" stroke-width="2"/>
        <rect x="38" y="44" width="544" height="364" fill="url(#vibe-grid)"/>
        <g data-pivot fill="none" stroke="#fbd46c" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">${motifs[motif]}</g>
        <circle data-pulse cx="${x}" cy="${y}" r="18" fill="none" stroke="#fbd46c" stroke-width="2"/>
      </svg>
    </div>`;
}
