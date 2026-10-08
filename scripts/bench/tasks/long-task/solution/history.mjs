export function createHistory() {
  const stack = [];
  return {
    push(items) {
      stack.push(structuredClone(items));
    },
    undo() {
      return stack.length ? structuredClone(stack.pop()) : null;
    },
  };
}
