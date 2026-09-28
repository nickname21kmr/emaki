type ClassValue = string | false | null | undefined | 0 | ClassValue[];

/** 拼接 className：cn('a', cond && 'b', ['c', null]) */
export function cn(...inputs: ClassValue[]): string {
  const out: string[] = [];
  for (const input of inputs) {
    if (!input) continue;
    if (Array.isArray(input)) {
      const nested = cn(...input);
      if (nested) out.push(nested);
    } else {
      out.push(input);
    }
  }
  return out.join(' ');
}
