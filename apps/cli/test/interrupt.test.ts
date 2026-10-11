import { expect, it } from 'vitest';
import { controlCPresses } from '../src/interrupt.js';
it('recognizes separate and coalesced ConPTY interrupts without treating text/paste as exit', () => {
  expect(controlCPresses('c', true)).toBe(1);
  expect(controlCPresses('\x03', false)).toBe(1);
  expect(controlCPresses('\x03\x03', false)).toBe(2);
  expect(controlCPresses('c', false)).toBe(0);
  expect(controlCPresses('abc\x03def', false)).toBe(0);
  expect(controlCPresses('C', true)).toBe(0);
});
