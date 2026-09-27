import { mkdir, writeFile } from 'node:fs/promises';
await mkdir('static/avatars', { recursive: true });
const colors = [
  '#24b47e',
  '#e5484d',
  '#8e4ec6',
  '#3e63dd',
  '#f76808',
  '#12a594',
  '#d6409f',
  '#978365',
  '#46a758',
  '#6e56cf',
];
for (let i = 0; i < 10; i++) {
  const n = String(i + 1).padStart(2, '0');
  await writeFile(
    `static/avatars/avatar-${n}.svg`,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect width="120" height="120" rx="24" fill="${colors[i]}"/><circle cx="60" cy="47" r="24" fill="#fff" opacity=".9"/><path d="M20 113c4-27 19-41 40-41s36 14 40 41" fill="#fff" opacity=".9"/><circle cx="51" cy="45" r="3"/><circle cx="69" cy="45" r="3"/><path d="M50 58q10 8 20 0" fill="none" stroke="#222" stroke-width="3"/></svg>`,
  );
}
