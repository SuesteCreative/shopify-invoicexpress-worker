export function validatePTNIF(nif: string): boolean {
  if (!/^\d{9}$/.test(nif)) return false;

  const firstDigit = parseInt(nif[0]);
  if (![1, 2, 3, 4, 5, 6, 7, 8, 9].includes(firstDigit)) return false;

  let sum = 0;
  for (let i = 0; i < 8; i++) {
    sum += parseInt(nif[i]) * (9 - i);
  }

  const remainder = sum % 11;
  const checkDigit = remainder < 2 ? 0 : 11 - remainder;

  return checkDigit === parseInt(nif[8]);
}
