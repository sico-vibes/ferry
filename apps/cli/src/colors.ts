const useColor = () =>
  process.env.FORCE_COLOR !== undefined ||
  (process.stdout.isTTY && process.env.NO_COLOR === undefined);
const ansi = (color: string, fallback: number, value: string) =>
  !useColor()
    ? value
    : `\u001b[${process.env.COLORTERM === 'truecolor' || process.env.COLORTERM === '24bit' ? `38;2;${color}` : `38;5;${fallback.toString()}`}m${value}\u001b[0m`;

export const blue = (s: string) => ansi('75;145;255', 75, s);
export const muted = (s: string) => ansi('145;151;163', 245, s);
export const good = (s: string) => ansi('67;195;139', 78, s);
export const warn = (s: string) => ansi('245;185;75', 214, s);
export const bad = (s: string) => ansi('244;91;105', 203, s);
export const emphasis = (s: string) => (useColor() ? `\u001b[1m${s}\u001b[0m` : s);
export const gradient = (s: string) =>
  !useColor()
    ? s
    : Array.from(s)
        .map(
          (c, i) => `\u001b[38;2;${(90 + i * 6).toString()};${(110 + i * 2).toString()};255m${c}`,
        )
        .join('') + '\u001b[0m';
