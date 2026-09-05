// Original, offline sample illustrations. Replace these URLs with selected Lakomics assets.
const svgUrl = (w: number, h: number, body: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`)}`;
const stars = Array.from({ length: 95 }, (_, i) => `<circle cx="${(i * 137.3) % 960}" cy="${(i * 79.7) % 550}" r="${i % 4 === 0 ? 1.8 : .8}" fill="#e8d9ae" opacity="${.2 + (i % 5) * .15}"/>`).join('');
export const DEMOS = [
  { name: '夜行便 / NIGHT FLIGHT', url: svgUrl(960, 720, `
    <defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="#142c48"/><stop offset=".68" stop-color="#48616d"/><stop offset="1" stop-color="#f0a080"/></linearGradient><linearGradient id="water" x2="0" y2="1"><stop stop-color="#538286"/><stop offset="1" stop-color="#102e43"/></linearGradient></defs>
    <path fill="url(#sky)" d="M0 0h960v720H0z"/>${stars}
    <circle cx="682" cy="203" r="128" fill="#ebbc99"/><circle cx="640" cy="173" r="126" fill="#263d51"/>
    <path d="M0 382 88 357 166 378 282 273 372 341 447 315 568 395 703 346 805 377 960 312V590H0" fill="#365762"/>
    <path d="m0 444 126-47 86 28 125-47 107 80 129-56 121 43 117-37 149 35v140H0" fill="#203e4d"/>
    <path fill="url(#water)" d="M0 475h960v245H0z"/>
    ${Array.from({length:32},(_,i)=>`<path d="M${(i*93)%960} ${494+i*7}h${18+(i*17)%140}" stroke="#82aaa0" stroke-width="2" opacity=".4"/>`).join('')}
    <path d="m0 689 112-47 215 14 190-38 207 27 236-48v123H0" fill="#112733"/>
    <g transform="translate(360 260) rotate(-12)"><path d="m-202 18 185-22 133-91 35 1-72 87 178 14 56-30 18 2-31 44-183 13-35 76-25 3 3-83-247 1z" fill="#d9d4bd"/><path d="m-174 24 445-5-35 18-413 1z" fill="#e5664c"/><path d="m-44 3 24-10 56-6-13 13z" fill="#253f51"/><path d="m15 45 23-1-5 47-12 3z" fill="#839492"/><circle cx="189" cy="14" r="3" fill="#ffdb8e"/><path d="m-251 34-119 7m108-20-77 4" stroke="#b4d2cb" opacity=".5" stroke-width="2"/></g>
    <path d="M91 626V419h8v207m-21-180h34m-39 24h45" stroke="#152b38" stroke-width="5"/><path d="M86 425h20l-5-8H91z" fill="#edb876"/>
    <text x="50" y="670" fill="#e8d8b7" font-family="monospace" font-size="15" letter-spacing="6">THE LAST FLIGHT HOME</text>
  `) },
  { name: '朱の庭 / VERMILION', url: svgUrl(600, 900, `
    <defs><linearGradient id="s" x2="0" y2="1"><stop stop-color="#1d3c42"/><stop offset="1" stop-color="#91b4a2"/></linearGradient></defs>
    <path fill="url(#s)" d="M0 0h600v900H0z"/><circle cx="330" cy="262" r="176" fill="#eec79e"/>
    <path d="M0 467 151 278 216 355 298 220 433 412 503 345 600 464V900H0" fill="#41615b"/>
    <path d="M0 565 146 454 264 539 420 448 600 560V900H0" fill="#274b48"/>
    <path d="m249 626 100 0 123 274H105z" fill="#779b85"/>
    ${Array.from({length:12},(_,i)=>`<path d="M${240-i*10} ${650+i*21}h${120+i*20}" stroke="#b3b89a" stroke-width="5"/>`).join('')}
    <g fill="#d65a3f"><path d="M132 355h34l-14 325h-37zm302 0h34l18 325h-37z"/><path d="M90 315q210 45 420 0l-11 40q-199 28-398 0z"/><path d="M112 396h377v22H112z"/><path d="M285 344h30v73h-30z"/></g><path d="M78 300q222 49 445 0l-8 21q-216 46-433 0z" fill="#152e32"/>
    <g fill="#193a36"><path d="M0 0h57l29 900H0zM600 0h-50l-40 900h90z"/><path d="m23 82 134 19 77 75-10 10-99-57-101 9zm546 113-156 34-86 80 21 6 86-60 132-12z"/></g>
    ${Array.from({length:50},(_,i)=>`<ellipse cx="${(i*139)%600}" cy="${(i*73)%850}" rx="${4+i%4}" ry="3" transform="rotate(${i*23} ${(i*139)%600} ${(i*73)%850})" fill="${i%2?'#e78d60':'#d4b178'}"/>`).join('')}
    <text x="485" y="92" fill="#efdbb6" font-family="serif" font-size="32" style="writing-mode:tb" letter-spacing="14">朱の庭</text>
  `) },
  { name: '深海通信 / DEEP SIGNAL', url: svgUrl(800, 800, `
    <defs><radialGradient id="o"><stop stop-color="#32777a"/><stop offset="1" stop-color="#0b283c"/></radialGradient></defs><path fill="url(#o)" d="M0 0h800v800H0z"/>
    ${Array.from({length:65},(_,i)=>`<circle cx="${(i*137)%800}" cy="${(i*73)%800}" r="${1+i%3}" fill="#87b8a7" opacity=".3"/>`).join('')}
    <g transform="translate(386 370) rotate(-15)"><ellipse rx="195" ry="151" fill="#c46a48"/><path d="M-192 30q190 151 384 0l-21 62q-158 123-342 0z" fill="#a64e3c"/><ellipse cy="-17" rx="140" ry="100" fill="#ddac6e"/><ellipse cy="-25" rx="94" ry="73" fill="#162f43"/><ellipse cx="-18" cy="-36" rx="62" ry="48" fill="#3f7c83"/><path d="m-48-56 49-21" stroke="#afccbd" stroke-width="9"/><path d="M-38-145v-72h78v72" fill="#ba7951"/><path d="M-42-225h86v21h-86z" fill="#dfb67c"/><path d="m-158 107-55 69 28 16 66-54m269-31 55 69-28 16-66-54" fill="#d69b63"/><circle cx="-158" cy="-8" r="13" fill="#ffdd9b"/><circle cx="158" cy="-8" r="13" fill="#ffdd9b"/></g>
    <path d="m0 693 67-93 56 64 87-54 92 74 170-50 90 54 105-110 73 90 60-25v157H0" fill="#132c39"/>
    <g fill="none" stroke="#599584" stroke-width="7"><path d="M89 749q-62-143-23-189m10 105q55-53 38-99M676 737q73-118 22-200m5 121q-78-68-50-117"/></g>
    <text x="44" y="72" fill="#b8d3bb" font-family="monospace" font-size="15" letter-spacing="5">NO. 03 / A SIGNAL FROM BELOW</text>
  `) },
];
