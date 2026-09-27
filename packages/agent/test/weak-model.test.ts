import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import {
  containsOmissionPlaceholder,
  parseTextToolCalls,
  ReflectionBudget,
  ToolRepetitionDetector,
} from '../src/weak-model.js';
describe('weak model recovery', () => {
  it('parses XML, fenced JSON, and repaired marker calls with aliases', () => {
    expect(
      parseTextToolCalls('<function=writefile><path>a</path><content>hello</content></function>', [
        'write_file',
      ]),
    ).toEqual([{ name: 'write_file', input: { path: 'a', content: 'hello' } }]);
    expect(
      parseTextToolCalls('```json\n{"tool":"edit_file","arguments":{"path":"a",}}\n```', [
        'edit_file',
      ]),
    ).toEqual([{ name: 'edit_file', input: { path: 'a' } }]);
    expect(parseTextToolCalls('tool_call: readfile {"path":"x"}', ['read_file'])).toEqual([
      { name: 'read_file', input: { path: 'x' } },
    ]);
  });
  it('bounds reflections and detects omissions and repeats', () => {
    const budget = new ReflectionBudget(3);
    expect([budget.consume(), budget.consume(), budget.consume(), budget.consume()]).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(containsOmissionPlaceholder({ content: '// rest of code...' })).toBe(true);
    const detector = new ToolRepetitionDetector();
    expect([
      detector.observe('read_file', { path: 'a' }),
      detector.observe('read_file', { path: 'a' }),
      detector.observe('read_file', { path: 'a' }),
    ]).toEqual([false, false, true]);
  });
  it('repairs fuzzed malformed JSON arguments', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-zA-Z0-9 _./-]{1,80}$/), (path) => {
        const malformed = '```json\n{"name":"read_file","arguments":{"path":"' + path + '",}}\n```';
        expect(parseTextToolCalls(malformed, ['read_file'])[0]?.input).toEqual({ path });
      }),
      { numRuns: 100 },
    );
  });
});
