/** ConPTY may deliver two Ctrl+C presses together instead of two key events. */
export function controlCPresses(input: string, ctrl: boolean): number {
  if (input.charCodeAt(0) === 3) {
    for (let index = 1; index < input.length; index++) if (input.charCodeAt(index) !== 3) return 0;
    return input.length;
  }
  return ctrl && input === 'c' ? 1 : 0;
}
