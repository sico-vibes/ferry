let name = 'world';
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--name' && process.argv[i + 1]) name = process.argv[++i];
  else process.exit(2);
}
console.log('Hello, ' + name + '!');
