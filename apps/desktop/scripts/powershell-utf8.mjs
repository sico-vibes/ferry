/** Windows PowerShell otherwise encodes piped output using the machine's legacy code page. */
export function powershellUtf8Arguments(script) {
  return [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); ${script}`,
  ];
}
