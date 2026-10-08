let name = 'world',
  uppercase = false;
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === '--name' && process.argv[i + 1] && !process.argv[i + 1].startsWith('--'))
    name = process.argv[++i];
  else if (arg === '--uppercase') uppercase = true;
  else process.exit(2);
}
const text = 'Hello, ' + name + '!';
console.log(uppercase ? text.toUpperCase() : text);
