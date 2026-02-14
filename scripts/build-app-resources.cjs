const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');
const out = path.join(root, 'dist', 'app');

const dirs = ['src', 'public', 'data'];
dirs.forEach((d) => {
  const src = path.join(root, d);
  const dest = path.join(out, d);
  if (!fs.existsSync(src)) {
    fs.mkdirSync(dest, { recursive: true });
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  cpDir(src, dest);
});

['package.json', 'package-lock.json'].forEach((f) => {
  const src = path.join(root, f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(out, f));
});

function cpDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) cpDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

execSync('npm install --omit=dev', { cwd: out, stdio: 'inherit' });
console.log('dist/app ready');
