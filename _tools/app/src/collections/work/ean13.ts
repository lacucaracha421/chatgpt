const left = ["0001101", "0011001", "0010011", "0111101", "0100011", "0110001", "0101111", "0111011", "0110111", "0001011"];
const even = ["0100111", "0110011", "0011011", "0100001", "0011101", "0111001", "0000101", "0010001", "0001001", "0010111"];
const parity = ["LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG", "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL"];

/** The 95 EAN-13 modules, including guards; invalid identifiers never become fake bars. */
export function encodeEan13(value: string): string | null {
  if (!/^\d{13}$/.test(value)) return null;
  const digits = [...value].map(Number);
  const sum = digits.slice(0, 12).reduce((total, digit, index) => total + digit * (index % 2 ? 3 : 1), 0);
  if ((10 - sum % 10) % 10 !== digits[12]) return null;
  const first = digits.slice(1, 7).map((digit, index) => (parity[digits[0]][index] === "L" ? left : even)[digit]).join("");
  const last = digits.slice(7).map(digit => [...left[digit]].map(bit => bit === "0" ? "1" : "0").join("")).join("");
  return `101${first}01010${last}101`;
}
