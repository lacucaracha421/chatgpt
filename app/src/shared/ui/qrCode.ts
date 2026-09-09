const VERSION = 7;
const SIZE = 45;
const DATA_CODEWORDS = 124;
const BLOCK_COUNT = 4;
const DATA_PER_BLOCK = 31;
const ECC_PER_BLOCK = 18;
const MAX_BYTES = 122;
const QUIET_ZONE = 4;

export type QrMatrix = readonly (readonly boolean[])[];

function multiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i -= 1) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function divisor(degree: number): number[] {
  const result = Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < degree; j += 1) {
      result[j] = multiply(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = multiply(root, 0x02);
  }
  return result;
}

function remainder(data: readonly number[], generator: readonly number[]): number[] {
  const result = Array<number>(generator.length).fill(0);
  for (const value of data) {
    const factor = value ^ result[0];
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    for (let i = 0; i < result.length; i += 1) result[i] ^= multiply(generator[i], factor);
  }
  return result;
}

function appendBits(target: number[], value: number, length: number) {
  for (let i = length - 1; i >= 0; i -= 1) target.push((value >>> i) & 1);
}

function encodeData(text: string): number[] {
  const bytes = [...new TextEncoder().encode(text)];
  if (bytes.length > MAX_BYTES) throw new Error(`QR payload is too long (${bytes.length}/${MAX_BYTES} bytes)`);
  const bits: number[] = [];
  appendBits(bits, 0b0100, 4);
  appendBits(bits, bytes.length, 8);
  for (const value of bytes) appendBits(bits, value, 8);
  const capacity = DATA_CODEWORDS * 8;
  for (let i = 0; i < Math.min(4, capacity - bits.length); i += 1) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let value = 0;
    for (let j = 0; j < 8; j += 1) value = (value << 1) | bits[i + j];
    data.push(value);
  }
  for (let pad = 0; data.length < DATA_CODEWORDS; pad += 1) data.push(pad % 2 === 0 ? 0xec : 0x11);
  return data;
}

function interleave(text: string): number[] {
  const data = encodeData(text);
  const generator = divisor(ECC_PER_BLOCK);
  const blocks = Array.from({ length: BLOCK_COUNT }, (_, index) => data.slice(index * DATA_PER_BLOCK, (index + 1) * DATA_PER_BLOCK));
  const ecc = blocks.map((block) => remainder(block, generator));
  const result: number[] = [];
  for (let i = 0; i < DATA_PER_BLOCK; i += 1) for (const block of blocks) result.push(block[i]);
  for (let i = 0; i < ECC_PER_BLOCK; i += 1) for (const block of ecc) result.push(block[i]);
  return result;
}

function getBit(value: number, index: number): boolean {
  return ((value >>> index) & 1) !== 0;
}

export function createQrMatrix(text: string): QrMatrix {
  const modules = Array.from({ length: SIZE }, () => Array<boolean>(SIZE).fill(false));
  const functions = Array.from({ length: SIZE }, () => Array<boolean>(SIZE).fill(false));
  const setFunction = (row: number, column: number, dark: boolean) => {
    if (row < 0 || column < 0 || row >= SIZE || column >= SIZE) return;
    modules[row][column] = dark;
    functions[row][column] = true;
  };
  const drawFinder = (centerRow: number, centerColumn: number) => {
    for (let dy = -4; dy <= 4; dy += 1) for (let dx = -4; dx <= 4; dx += 1) {
      const distance = Math.max(Math.abs(dx), Math.abs(dy));
      setFunction(centerRow + dy, centerColumn + dx, distance !== 2 && distance !== 4);
    }
  };
  const drawAlignment = (centerRow: number, centerColumn: number) => {
    for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) {
      setFunction(centerRow + dy, centerColumn + dx, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  };

  for (let i = 0; i < SIZE; i += 1) {
    setFunction(6, i, i % 2 === 0);
    setFunction(i, 6, i % 2 === 0);
  }
  drawFinder(3, 3);
  drawFinder(3, SIZE - 4);
  drawFinder(SIZE - 4, 3);
  const centers = [6, 22, 38];
  for (let row = 0; row < centers.length; row += 1) for (let column = 0; column < centers.length; column += 1) {
    if ((row === 0 && column === 0) || (row === 0 && column === centers.length - 1) || (row === centers.length - 1 && column === 0)) continue;
    drawAlignment(centers[row], centers[column]);
  }

  const mask = 0;
  let formatRemainder = mask; // Error-correction level M uses format bits 00.
  for (let i = 0; i < 10; i += 1) formatRemainder = (formatRemainder << 1) ^ ((formatRemainder >>> 9) * 0x537);
  const formatBits = ((mask << 10) | formatRemainder) ^ 0x5412;
  for (let i = 0; i <= 5; i += 1) setFunction(i, 8, getBit(formatBits, i));
  setFunction(7, 8, getBit(formatBits, 6));
  setFunction(8, 8, getBit(formatBits, 7));
  setFunction(8, 7, getBit(formatBits, 8));
  for (let i = 9; i < 15; i += 1) setFunction(8, 14 - i, getBit(formatBits, i));
  for (let i = 0; i < 8; i += 1) setFunction(8, SIZE - 1 - i, getBit(formatBits, i));
  for (let i = 8; i < 15; i += 1) setFunction(SIZE - 15 + i, 8, getBit(formatBits, i));
  setFunction(SIZE - 8, 8, true);

  let versionRemainder = VERSION;
  for (let i = 0; i < 12; i += 1) versionRemainder = (versionRemainder << 1) ^ ((versionRemainder >>> 11) * 0x1f25);
  const versionBits = (VERSION << 12) | versionRemainder;
  for (let i = 0; i < 18; i += 1) {
    const bit = getBit(versionBits, i);
    const a = SIZE - 11 + (i % 3);
    const b = Math.floor(i / 3);
    setFunction(b, a, bit);
    setFunction(a, b, bit);
  }

  const codewords = interleave(text);
  const dataBits: boolean[] = [];
  for (const value of codewords) for (let i = 7; i >= 0; i -= 1) dataBits.push(((value >>> i) & 1) !== 0);
  let bitIndex = 0;
  for (let right = SIZE - 1; right >= 1; right -= 2) {
    if (right === 6) right -= 1;
    for (let vertical = 0; vertical < SIZE; vertical += 1) {
      const row = ((right + 1) & 2) === 0 ? SIZE - 1 - vertical : vertical;
      for (let offset = 0; offset < 2; offset += 1) {
        const column = right - offset;
        if (functions[row][column]) continue;
        const bit = bitIndex < dataBits.length ? dataBits[bitIndex] : false;
        modules[row][column] = bit !== ((row + column) % 2 === 0);
        bitIndex += 1;
      }
    }
  }
  if (bitIndex !== codewords.length * 8) throw new Error("QR placement did not consume all codewords");
  return modules;
}

export function qrSvgPath(matrix: QrMatrix): string {
  const parts: string[] = [];
  matrix.forEach((row, y) => row.forEach((dark, x) => { if (dark) parts.push(`M${x + QUIET_ZONE} ${y + QUIET_ZONE}h1v1h-1z`); }));
  return parts.join("");
}

export const QR_VIEWBOX_SIZE = SIZE + QUIET_ZONE * 2;
export const QR_MAX_BYTES = MAX_BYTES;
